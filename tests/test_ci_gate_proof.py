def test_intentional_ci_gate_failure() -> None:
    """Disposable: proves required Python tests check turns red (#91)."""
    assert False, "intentional disposable failure for #91 gate proof"
