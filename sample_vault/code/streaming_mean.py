"""Synthetic teaching example, not code copied from a paper or benchmark answer."""

def update_mean(previous_mean, count, observation):
    """Incremental mean: new_mean = old_mean + (x - old_mean)/(n+1)."""
    if count < 0:
        raise ValueError("count must be non-negative")
    return previous_mean + (observation - previous_mean) / (count + 1)
