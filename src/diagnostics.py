import socket
from typing import Any

import requests
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from .logger import get_logger
from .utils import get_working_domain, test_proxy_connectivity

logger = get_logger()
console = Console()


def check_ip_address() -> tuple[bool, str]:
    """Hits an external IP echo service to verify public IP."""
    try:
        res = requests.get("https://api.ipify.org", timeout=5, verify=True)
        ip = res.text
        return True, f"Public IP Address: [bold yellow]{ip}[/bold yellow] (your current public egress IP)"
    except requests.RequestException as e:
        return False, f"Public IP Check: [bold red]FAILED[/bold red] ({e})"


def check_internet() -> tuple[bool, str]:
    """Checks basic internet connectivity."""
    try:
        socket.create_connection(("8.8.8.8", 53), timeout=3)
        return True, "Internet Connection: [bold green]ONLINE[/bold green]"
    except OSError:
        return False, "Internet Connection: [bold red]OFFLINE[/bold red]"


def check_site_reachability(base_url: str) -> tuple[bool, str]:
    """Checks if Anna's Archive is reachable."""
    try:
        response = requests.get(base_url, timeout=5, verify=True)
        if response.status_code == 200:
            return True, f"Anna's Archive ({base_url}): [bold green]REACHABLE[/bold green]"
        else:
            return False, f"Anna's Archive: [bold yellow]HTTP {response.status_code}[/bold yellow]"
    except requests.RequestException:
        return False, "Anna's Archive: [bold red]UNREACHABLE[/bold red]"


def check_chrome_automation() -> tuple[bool, str]:
    """Checks if undetected_chromedriver is importable."""
    try:
        import undetected_chromedriver as uc  # noqa: F401

        return True, "Browser Automation: [bold green]READY[/bold green]"
    except ImportError:
        return False, "Browser Automation: [bold red]NOT READY[/bold red] (pip install undetected-chromedriver)"


def check_proxies(proxies: list[str]) -> tuple[bool | None, str]:
    """Test each configured proxy and report the results.

    Returns ``(True, ...)`` when all proxies pass, ``(None, ...)`` when none are
    configured, or ``(False, ...)`` when at least one proxy fails.
    """
    if not proxies:
        return None, "Proxies: [bold yellow]NONE CONFIGURED[/bold yellow]"

    passed: list[str] = []
    failed: list[str] = []
    for url in proxies:
        ok, msg = test_proxy_connectivity(url)
        label = url.split("@")[-1]  # redact credentials
        if ok:
            passed.append(label)
        else:
            failed.append(f"{label} ({msg})")

    if failed:
        fail_list = ", ".join(failed)
        return False, f"Proxies: [bold red]{len(failed)} FAILED[/bold red] — {fail_list}"
    pass_list = ", ".join(passed)
    return True, f"Proxies: [bold green]{len(passed)} OK[/bold green] — {pass_list}"


def check_tls_fingerprint() -> tuple[bool | None, str]:
    """Check if TLS fingerprint impersonation is available via curl_cffi."""
    try:
        from curl_cffi import requests as _cr  # noqa: F401

        return True, "TLS Fingerprint: [bold green]STEALTH[/bold green] (curl_cffi impersonating Chrome)"
    except ImportError:
        return None, "TLS Fingerprint: [bold yellow]STANDARD[/bold yellow] (pip install curl_cffi for stealth)"


def run_diagnostics(config: dict[str, Any]) -> None:
    """Runs a full suite of system diagnostics including IP leak test."""
    console.print("\n[bold magenta]Running System Pre-flight Check...[/bold magenta]\n")

    # Use configured base_url or auto-detect the working domain
    base_url = config.get("base_url") or get_working_domain()

    proxies: list[str] = config.get("proxies") or []
    results = [
        check_internet(),
        check_ip_address(),
        check_site_reachability(base_url),
        check_chrome_automation(),
        check_tls_fingerprint(),
        check_proxies(proxies),
    ]

    table = Table(show_header=False, box=None)
    for success, message in results:
        icon = (
            "[green]OK[/green]"
            if success is True
            else "[red]FAIL[/red]"
            if success is False
            else "[yellow]WARN[/yellow]"
        )
        table.add_row(icon, message)

    console.print(Panel(table, title="System Health Report", border_style="cyan"))

    if all(r[0] is not False for r in results):
        console.print("\n[bold green]System is ready for download operations![/bold green]")
    else:
        console.print("\n[bold red]Issues detected. Please fix FAIL items before proceeding.[/bold red]")
