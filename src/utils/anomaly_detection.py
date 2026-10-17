"""
Anomaly Detection for Syndromic Surveillance.

Implements CUSUM (Cumulative Sum) and Poisson-based statistical methods
for detecting unusual increases in syndrome counts — standard methods
used by CDC and WHO for outbreak detection.
"""

import numpy as np
from scipy import stats
from typing import Optional
from loguru import logger


def cusum_detect(
    counts: np.ndarray,
    baseline_mean: float,
    baseline_std: Optional[float] = None,
    k: float = 1.5,
    h: float = 5.0,
) -> dict:
    """
    Cumulative Sum (CUSUM) control chart for outbreak detection.
    
    Detects sustained shifts above the baseline mean. Used by CDC's
    Early Aberration Reporting System (EARS).
    
    Args:
        counts: Array of weekly/daily syndrome counts (chronological order)
        baseline_mean: Expected mean count
        baseline_std: Expected standard deviation (estimated from counts if None)
        k: Allowance parameter (sensitivity — lower = more sensitive). Default 1.5
        h: Decision interval (threshold for alarm). Default 5.0
    
    Returns:
        dict with:
            - alarm: bool, whether CUSUM triggered
            - cusum_values: array of CUSUM statistics over time
            - alarm_index: index where alarm first triggered (None if no alarm)
            - current_cusum: latest CUSUM value
    """
    counts = np.asarray(counts, dtype=float)

    if baseline_std is None:
        baseline_std = max(np.sqrt(baseline_mean), 1.0)  # Poisson assumption

    # Standardize
    allowance = k * baseline_std
    cusum_high = np.zeros(len(counts))
    alarm_index = None

    for i in range(len(counts)):
        deviation = counts[i] - baseline_mean - allowance
        if i == 0:
            cusum_high[i] = max(0, deviation)
        else:
            cusum_high[i] = max(0, cusum_high[i - 1] + deviation)

        if cusum_high[i] > h * baseline_std and alarm_index is None:
            alarm_index = i

    alarm = cusum_high[-1] > h * baseline_std if len(cusum_high) > 0 else False

    return {
        "alarm": alarm,
        "cusum_values": cusum_high.tolist(),
        "alarm_index": alarm_index,
        "current_cusum": float(cusum_high[-1]) if len(cusum_high) > 0 else 0.0,
    }


def poisson_test(
    observed: int,
    expected: float,
    alpha: float = 0.01,
) -> dict:
    """
    One-sided Poisson test for excess cases.
    
    Tests whether the observed count is significantly higher than expected
    under a Poisson model — a standard method for syndromic surveillance.
    
    Args:
        observed: Observed case count this period
        expected: Expected (baseline) count
        alpha: Significance level (default 0.01 for high specificity)
    
    Returns:
        dict with:
            - significant: bool, whether the excess is statistically significant
            - p_value: one-sided p-value
            - ratio: observed/expected ratio
            - excess: observed - expected
            - critical_value: minimum count that would trigger significance
    """
    if expected <= 0:
        return {
            "significant": observed > 0,
            "p_value": 0.0 if observed > 0 else 1.0,
            "ratio": float("inf") if observed > 0 else 0.0,
            "excess": observed,
            "critical_value": 1,
        }

    # P(X >= observed | lambda=expected) using survival function
    p_value = stats.poisson.sf(observed - 1, expected)

    # Critical value: smallest k where P(X >= k) < alpha
    critical_value = int(stats.poisson.ppf(1 - alpha, expected)) + 1

    return {
        "significant": p_value < alpha,
        "p_value": float(p_value),
        "ratio": round(observed / expected, 2),
        "excess": observed - expected,
        "critical_value": critical_value,
    }


def ears_c1(
    counts: np.ndarray,
    baseline_window: int = 7,
    threshold: float = 3.0,
) -> dict:
    """
    CDC EARS C1 algorithm (simplified).
    
    Compares current count against recent baseline using a z-score approach.
    
    Args:
        counts: Array of daily/weekly counts (chronological)
        baseline_window: Number of prior periods for baseline calculation
        threshold: Z-score threshold for alarm (default 3.0)
    
    Returns:
        dict with alarm status and z-scores
    """
    counts = np.asarray(counts, dtype=float)

    if len(counts) < baseline_window + 1:
        return {
            "alarm": False,
            "z_scores": [],
            "message": f"Need at least {baseline_window + 1} data points",
        }

    z_scores = []
    alarms = []

    for i in range(baseline_window, len(counts)):
        baseline = counts[i - baseline_window : i]
        mean = np.mean(baseline)
        std = max(np.std(baseline, ddof=1), 1.0)

        z = (counts[i] - mean) / std
        z_scores.append(float(z))
        alarms.append(z > threshold)

    return {
        "alarm": bool(alarms[-1]) if alarms else False,
        "z_scores": z_scores,
        "latest_z": float(z_scores[-1]) if z_scores else 0.0,
        "alarm_periods": [
            i + baseline_window for i, a in enumerate(alarms) if a
        ],
    }


def detect_anomalies(
    weekly_counts: np.ndarray,
    baseline_weeks: int = 8,
    method: str = "combined",
) -> dict:
    """
    Run combined anomaly detection on a weekly time series.
    
    Uses both CUSUM and Poisson methods and reports consensus.
    
    Args:
        weekly_counts: Array of weekly case counts
        baseline_weeks: Number of weeks for baseline calculation
        method: "cusum", "poisson", "ears", or "combined"
    
    Returns:
        Comprehensive anomaly detection results
    """
    counts = np.asarray(weekly_counts, dtype=float)

    if len(counts) < 2:
        return {
            "alarm": False,
            "method": method,
            "message": "Insufficient data for analysis",
        }

    # Calculate baseline from earlier weeks (excluding most recent)
    if len(counts) > baseline_weeks:
        baseline = counts[:baseline_weeks]
    else:
        baseline = counts[:-1] if len(counts) > 1 else counts

    baseline_mean = float(np.mean(baseline))
    baseline_std = float(max(np.std(baseline, ddof=1), np.sqrt(baseline_mean), 1.0))
    current = int(counts[-1])

    results = {
        "current_count": current,
        "baseline_mean": round(baseline_mean, 2),
        "baseline_std": round(baseline_std, 2),
        "ratio": round(current / max(baseline_mean, 0.1), 2),
    }

    if method in ("cusum", "combined"):
        results["cusum"] = cusum_detect(counts, baseline_mean, baseline_std)

    if method in ("poisson", "combined"):
        results["poisson"] = poisson_test(current, baseline_mean)

    if method in ("ears", "combined"):
        results["ears"] = ears_c1(counts)

    # Combined alarm: trigger if ANY method detects
    if method == "combined":
        alarms = []
        if "cusum" in results:
            alarms.append(results["cusum"]["alarm"])
        if "poisson" in results:
            alarms.append(results["poisson"]["significant"])
        if "ears" in results:
            alarms.append(results["ears"]["alarm"])
        results["alarm"] = any(alarms)
        results["alarm_methods"] = [
            m for m, a in zip(["cusum", "poisson", "ears"], alarms) if a
        ]
    else:
        if method == "cusum":
            results["alarm"] = results["cusum"]["alarm"]
        elif method == "poisson":
            results["alarm"] = results["poisson"]["significant"]
        elif method == "ears":
            results["alarm"] = results["ears"]["alarm"]

    results["method"] = method
    return results
