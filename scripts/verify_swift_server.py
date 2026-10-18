"""Verify a built Swift server using isolated SQLite and synthetic worker fixtures.

Never accesses the application's database or loads clinical models. Requires a
built native server supplied by --server-bin. Output is migration evidence only.
"""
import argparse
import fcntl
from contextlib import contextmanager
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shlex
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time

import httpx
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.data.syndromic_schema import ClinicalEncounter

ROOT = Path(__file__).resolve().parents[1]


def main(args):
    checks = []
    def check(name, condition):
        if not condition:
            raise AssertionError(name)
        checks.append(name)
        print('PASS ' + name, flush=True)
    with tempfile.TemporaryDirectory(prefix='epicast-server-check-') as directory:
        directory = Path(directory)
        database = directory / 'swift.sqlite3'
        cases = json.loads((ROOT/'native/Server/Tests/ServerCoreTests/Fixtures/surveillance.json').read_text())
        seed = cases[0]
        delta = datetime.now() - datetime.fromisoformat(seed['now'])
        with sqlite3.connect(database) as connection:
            connection.execute('CREATE TABLE encounters (id TEXT PRIMARY KEY, record TEXT NOT NULL, provenance TEXT NOT NULL)')
            for record in seed['records']:
                record = dict(record, timestamp=(datetime.fromisoformat(record['timestamp'])+delta).isoformat())
                encounter = ClinicalEncounter.model_validate(record).model_copy(update={
                    'narrative_text': '', 'image_path': None, 'location_lat': None, 'location_lon': None})
                connection.execute('INSERT INTO encounters VALUES (?, ?, ?)',
                                   (encounter.encounter_id, encounter.model_dump_json(), '{"model":"test-only"}'))
        initial_count = len(seed['records'])
        launcher = directory / 'python-fixture'
        fixture = ROOT/'native/Server/Tests/ServerCoreTests/Fixtures/api_worker.py'
        launcher.write_text('#!/bin/sh\nexec '+shlex.quote(sys.executable)+' '+shlex.quote(str(fixture))+'\n')
        launcher.chmod(0o700)
        with socket.socket() as port_socket:
            port_socket.bind(('127.0.0.1', 0))
            port = port_socket.getsockname()[1]
        environment = dict(os.environ, EPICAST_ROOT=str(ROOT), EPICAST_DATABASE=str(database), EPICAST_PORT=str(port),
                           EPICAST_PYTHON=str(launcher), EPICAST_ARTIFACT='', EPICAST_BACKEND='mlx', EPICAST_REMOTE_27B_URL='')
        log = (directory/'server.log').open('w')
        process = subprocess.Popen([str(Path(args.server_bin).resolve())], cwd=ROOT, env=environment, stdout=log, stderr=log)
        try:
            with httpx.Client(base_url=f'http://127.0.0.1:{port}', timeout=10, trust_env=False) as client:
                for _ in range(150):
                    if process.poll() is not None:
                        raise RuntimeError('Swift server exited: '+(directory/'server.log').read_text()[-3000:])
                    try:
                        if client.get('/health').status_code == 200:
                            break
                    except httpx.HTTPError:
                        pass
                    time.sleep(.1)
                else:
                    raise RuntimeError('Swift server did not start')
                check('health and truthful readiness', client.get('/health').json()['release_validated'] is False)
                with open(str(database.resolve())+'.writer.lock', 'a') as lease:
                    try:
                        fcntl.flock(lease.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        check('exclusive native database lease', True)
                    else:
                        fcntl.flock(lease.fileno(), fcntl.LOCK_UN)
                        check('exclusive native database lease', False)
                dashboard = client.get('/dashboard')
                check('seeded dashboard count', dashboard.status_code == 200 and dashboard.json()['total_encounters'] == initial_count)
                alerts = client.get('/alerts')
                check('seeded alerts', alerts.status_code == 200 and len(alerts.json()['alerts']) > 0)
                for route in ('/surveillance/scan', '/surveillance/scan?district=TEST%20North'):
                    response = client.get(route)
                    check('seeded scan '+route, response.status_code == 200 and isinstance(response.json(), dict))
                fhir = client.get('/fhir/report?district=TEST%20North')
                check('seeded FHIR bundle', fhir.status_code == 200 and fhir.json()['resourceType'] == 'Bundle' and len(fhir.json()['entry']) > 0)
                for method, route, payload, expected in (
                    ('POST', '/encounter', {'narrative':' '}, 422),
                    ('POST', '/encounter', {'narrative':'x'*16001}, 422),
                    ('POST', '/transcribe', {'audio_base64':'invalid'}, 422),
                    ('POST', '/jobs/report', {'district':'TEST','max_tokens':1025}, 422),
                    ('GET', '/jobs/missing', None, 404),
                    ('GET', '/hear/spectrogram', None, 410),
                    ('GET', '/fhir/report', None, 422),
                ):
                    result = client.request(method, route, json=payload) if payload is not None else client.request(method, route)
                    check(f'{expected} {method} {route}', result.status_code == expected and 'detail' in result.json())
                plain = client.post('/encounter', content='{"narrative":"Synthetic plain text request"}', headers={'Content-Type':'text/plain'})
                check('JSON content type required', plain.status_code == 422)
                encounter = client.post('/encounter', json={'narrative':'PRIVATE SYNTHETIC TEST','district':'TEST','facility_name':'TEST Clinic'})
                check('text encounter', encounter.status_code == 200 and encounter.json()['syndromic_signal']['symptoms'] == ['fever'])
                def wait(job):
                    for _ in range(300):
                        current = client.get('/jobs/'+job['id']).json()
                        if current['status'] in ('succeeded','failed','cancelled'):
                            return current
                        time.sleep(.02)
                    raise TimeoutError('Job did not finish')
                job = client.post('/jobs/multimodal', json={'narrative':'Synthetic multimodal','district':'TEST','image_base64':'dGVzdA==','audio_base64':'dGVzdA=='}).json()
                result = wait(job)
                check('multimodal job', result['status']=='succeeded' and set(result['result']) == {'text','image','cough','encounter'})
                failed = wait(client.post('/jobs/multimodal', json={'narrative':'Synthetic failed image','image_base64':'RkFJTA=='}).json())
                check('failed modality job', failed['status']=='failed')
                check('failed modality does not persist encounter', client.get('/dashboard').json()['total_encounters']==initial_count+2)
                for route, payload, key in (('/transcribe',{'audio_base64':'dGVzdA=='},'transcription'),('/image-triage',{'image_base64':'dGVzdA=='},'medgemma_analysis'),('/encounter/image',{'image_base64':'dGVzdA=='},'medgemma_analysis'),('/cough/analyze',{'audio_base64':'dGVzdA=='},'classification')):
                    response=client.post(route,json=payload)
                    check(route+' contract',response.status_code==200 and key in response.json())
                report = wait(client.post('/jobs/report', json={'district':'TEST'}).json())
                check('report provenance and draft', report['status']=='succeeded' and report['result']['draft'] and report['result']['provenance']['model']=='synthetic-contract-fixture')
                with client.stream('GET','/jobs/'+report['id']+'/events') as stream:
                    check('SSE terminal status', stream.status_code==200 and 'event: status' in stream.read().decode())
                alert=client.get('/alerts').json()['alerts'][0]
                advisory=client.post('/alert/advisory',json={'alert_id':alert['alert_id']})
                check('alert advisory',advisory.status_code==200 and advisory.json()['draft'])
                slow=client.post('/jobs/report',json={'district':'TEST Slow'}).json()
                for _ in range(100):
                    if client.get('/health').json()['runtime']['active']:
                        break
                    time.sleep(.01)
                latencies=[]
                for _ in range(20):
                    start=time.monotonic()
                    check_health=client.get('/health')
                    latencies.append(time.monotonic()-start)
                    assert check_health.status_code==200
                check('health responsive during inference',max(latencies)<.25)
                cancelled=client.delete('/jobs/'+slow['id'])
                check('active job cancellation',cancelled.status_code==200 and cancelled.json()['status']=='cancelled')
                recovery=wait(client.post('/jobs/report',json={'district':'TEST','refresh':True}).json())
                check('worker recovers after cancellation',recovery['status']=='succeeded')
                with sqlite3.connect(database) as connection:
                    records=''.join(row[0] for row in connection.execute('SELECT record FROM encounters'))
                    check('raw narrative excluded from SQLite', 'PRIVATE SYNTHETIC TEST' not in records)
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait()
            log.close()
        check('graceful server exit',process.returncode in (0,-15))
        with sqlite3.connect(database) as connection:
            check('native encounters durable after exit', connection.execute('SELECT count(*) FROM encounters').fetchone()[0] == initial_count+2)
            check('native report job durable after exit', connection.execute('SELECT status FROM jobs WHERE id=?', (report['id'],)).fetchone()[0] == 'succeeded')

        @contextmanager
        def stage(**overrides):
            with socket.socket() as available:
                available.bind(('127.0.0.1', 0))
                next_port = available.getsockname()[1]
            stage_env = dict(environment, EPICAST_PORT=str(next_port))
            stage_env.update(overrides)
            with (directory/'stage.log').open('w') as stage_log:
                stage_process = subprocess.Popen([str(Path(args.server_bin).resolve())], cwd=ROOT, env=stage_env, stdout=stage_log, stderr=stage_log)
                try:
                    with httpx.Client(base_url=f'http://127.0.0.1:{next_port}',timeout=10,trust_env=False) as stage_client:
                        for _ in range(100):
                            try:
                                if stage_client.get('/health').status_code == 200:
                                    break
                            except httpx.HTTPError:
                                pass
                            time.sleep(.1)
                        else:
                            raise RuntimeError('Verification stage did not start: '+(directory/'stage.log').read_text()[-1000:])
                        yield stage_client
                finally:
                    stage_process.terminate()
                    try:
                        stage_process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        stage_process.kill(); stage_process.wait()

        captured=[]
        class Remote(BaseHTTPRequestHandler):
            redirect=False
            def do_POST(self):
                data=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                captured.append(data)
                if self.redirect:
                    self.send_response(302)
                    self.send_header('Location','/must-not-follow')
                    self.end_headers()
                    return
                body=json.dumps({'model':'google/medgemma-27b-text-it','system_fingerprint':'test-only','choices':[{'message':{'content':'Synthetic remote draft.'}}]}).encode()
                self.send_response(200)
                self.send_header('Content-Type','application/json')
                self.send_header('Content-Length',str(len(body)))
                self.end_headers(); self.wfile.write(body)
            def log_message(self,*args):
                pass
        remote=ThreadingHTTPServer(('127.0.0.1',0),Remote)
        threading.Thread(target=remote.serve_forever,daemon=True).start()
        def stage_report(client):
            job=client.post('/jobs/report',json={'district':'TEST','refresh':True}).json()
            for _ in range(300):
                status=client.get('/jobs/'+job['id']).json()
                if status['status'] in ('succeeded','failed','cancelled'):
                    return status
                time.sleep(.02)
            raise TimeoutError('Remote report stage timed out')
        try:
            with stage(EPICAST_REMOTE_27B_URL=f'http://127.0.0.1:{remote.server_port}/v1/chat/completions') as remote_client:
                result=stage_report(remote_client)
                check('remote report execution',result['status']=='succeeded' and result['result']['provenance']['location']=='remote')
                outbound=json.dumps(captured)
                check('remote aggregate allowlist','PRIVATE SYNTHETIC TEST' not in outbound and 'TEST Clinic' not in outbound and 'encounter_id' not in outbound)
                Remote.redirect=True
                result=stage_report(remote_client)
                check('remote redirect rejected with local fallback',result['status']=='succeeded' and result['result']['provenance']['location']=='local' and result['result']['fallback_reason'] is not None)
        finally:
            remote.shutdown(); remote.server_close()
        with stage(EPICAST_PYTHON=sys.executable) as real_client:
            failure=real_client.post('/encounter',json={'narrative':'Synthetic test without artifact'})
            check('real worker rejects missing unvalidated artifact',failure.status_code==503 and 'EPICAST_ARTIFACT' in failure.json()['detail'])
            check('health survives real worker error',real_client.get('/health').status_code==200)
    result={'migration_passed':True,'model_validation_passed':False,'checks':checks,'health_max_seconds':max(latencies)}
    Path(args.output).write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'checks':len(checks),'health_max_seconds':max(latencies)}))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server-bin',required=True)
    parser.add_argument('--output',default='server-migration-results.json')
    main(parser.parse_args())
