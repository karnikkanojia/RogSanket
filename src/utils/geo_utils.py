"""
Geographic utilities for location handling in surveillance data.
"""

import math
from typing import Optional


def haversine_distance(
    lat1: float, lon1: float,
    lat2: float, lon2: float,
) -> float:
    """Calculate distance in km between two coordinates using Haversine formula."""
    R = 6371  # Earth's radius in km

    lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1

    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    c = 2 * math.asin(math.sqrt(a))

    return R * c


def cluster_by_proximity(
    locations: list[tuple[float, float]],
    threshold_km: float = 10.0,
) -> list[list[int]]:
    """
    Simple proximity clustering for outbreak detection.
    Groups locations within threshold_km of each other.
    
    Returns list of clusters (each cluster is a list of indices).
    """
    n = len(locations)
    visited = set()
    clusters = []

    for i in range(n):
        if i in visited:
            continue
        cluster = [i]
        visited.add(i)

        for j in range(i + 1, n):
            if j in visited:
                continue
            dist = haversine_distance(
                locations[i][0], locations[i][1],
                locations[j][0], locations[j][1],
            )
            if dist <= threshold_km:
                cluster.append(j)
                visited.add(j)

        clusters.append(cluster)

    return clusters
