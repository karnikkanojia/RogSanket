"""Verify a built Swift server against FastAPI and isolated synthetic worker fixtures.

Never accesses the application's database or loads clinical models. Requires a
built native server supplied by --server-bin. Output is migration evidence only.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta
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
from fastapi.testclient import TestClient
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.api.app import app
from src.data.syndromic_schema import ClinicalEncounter
from src.runtime.storage import Store

ROOT = Path(__file__).resolve().parents[1]


def normalize(value):
    if isinstance(value, list):
        result = [normalize(item) for item in value]
        if result and isinstance(result[0], dict) and 'alert_id' in result[0]:
            result.sort(key=lambda item: item['alert_id'])
        if result and isinstance(result[0], dict) and 'resource' in result[0]:
            result.sort(key=lambda item: json.dumps(item, sort_keys=True))
        return result
    if isinstance(value, dict):
        ignored = {'timestamp', 'scan_time', 'identifiedDateTime'}
        if value.get('resourceType') in ('Bundle', 'Composition', 'Observation'):
            ignored |= {'id', 'date'}
        if set(value) == {'start', 'end'}:
            return {'period_days': 7}
        return {key: normalize(item) for key, item in value.items() if key not in ignored}
    return value


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
        reference = directory / 'python.sqlite3'
        cases = json.loads((ROOT/'native/Server/Tests/ServerCoreTests/Fixtures/surveillance.json').read_text())
        seed = cases[0]
        delta = datetime.now() - datetime.fromisoformat(seed['now'])
        store = Store(str(database))
        for record in seed['records']:
            record = dict(record, timestamp=(datetime.fromisoformat(record['timestamp'])+delta).isoformat())
            store.add_encounter(ClinicalEncounter.model_validate(record), {'model': 'test-only'})
        initial_count = store.total_encounters
        store.close()
        with sqlite3.connect(database) as source, sqlite3.connect(reference) as target:
            source.backup(target)
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
                try:
                    duplicate = Store(str(database))
                except RuntimeError:
                    check('Python cannot acquire Swift database lease', True)
                else:
                    duplicate.close()
                    check('Python cannot acquire Swift database lease', False)
                previous = os.environ.get('EPICAST_DATABASE')
                os.environ['EPICAST_DATABASE'] = str(reference)
                try:
                    with TestClient(app) as python:
                        for route in ('/dashboard', '/alerts', '/surveillance/scan', '/surveillance/scan?district=TEST%20North', '/fhir/report?district=TEST%20North'):
                            left, right = client.get(route), python.get(route)
                            if normalize(left.json()) != normalize(right.json()):
                                import difflib
                                print('\n'.join(difflib.unified_diff(json.dumps(normalize(right.json()),indent=2,sort_keys=True).splitlines(),json.dumps(normalize(left.json()),indent=2,sort_keys=True).splitlines(),fromfile='python',tofile='swift')),flush=True)
                            check('API parity '+route, left.status_code == right.status_code == 200 and normalize(left.json()) == normalize(right.json()))
                finally:
                    if previous is None:
                        os.environ.pop('EPICAST_DATABASE', None)
                    else:
                        os.environ['EPICAST_DATABASE'] = previous
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
        reopened=Store(str(database))
        check('Python rollback reads native encounters',reopened.total_encounters==initial_count+2)
        check('Python rollback reads native report job',reopened.get_job(report['id'])['status']=='succeeded')
        reopened.close()

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
