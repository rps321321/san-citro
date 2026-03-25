import os
import sqlite3
from typing import Tuple, Optional, Dict, Any
import requests
import socket
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from logger import get_logger

logger = get_logger()
console = Console()


def check_ip_address() -> Tuple[bool, str]:
    """Hits an external IP echo service to verify public IP."""
    try:
        res = requests.get("https://api.ipify.org", timeout=5, verify=True)
        ip = res.text
        return True, f"Public IP Address: [bold yellow]{ip}[/bold yellow] (Verify this is your VPN!)"
    except requests.RequestException as e:
        return False, f"Public IP Check: [bold red]FAILED[/bold red] ({e})"


def check_internet() -> Tuple[bool, str]:
    """Checks basic internet connectivity."""
    try:
        socket.create_connection(("8.8.8.8", 53), timeout=3)
        return True, "Internet Connection: [bold green]ONLINE[/bold green]"
    except OSError:
        return False, "Internet Connection: [bold red]OFFLINE[/bold red]"


def check_site_reachability(base_url: str) -> Tuple[bool, str]:
    """Checks if Anna's Archive is reachable."""
    try:
        response = requests.get(base_url, timeout=5, verify=True)
        if response.status_code == 200:
            return True, f"Anna's Archive ({base_url}): [bold green]REACHABLE[/bold green]"
        else:
            return False, f"Anna's Archive: [bold yellow]HTTP {response.status_code}[/bold yellow]"
    except requests.RequestException:
        return False, "Anna's Archive: [bold red]UNREACHABLE[/bold red]"


def check_database(db_path: Optional[str]) -> Tuple[Optional[bool], str]:
    """Verifies database health and record count."""
    if not db_path or not os.path.exists(db_path):
        return None, "Database: [bold yellow]NOT CONFIGURED[/bold yellow]"
    try:
        with sqlite3.connect(db_path) as conn:
            res = conn.execute("PRAGMA integrity_check").fetchone()[0]
            count = conn.execute("SELECT COUNT(*) FROM records").fetchone()[0]
        if res == "ok":
            return True, f"Database: [bold green]HEALTHY[/bold green] ({count:,} records)"
        else:
            return False, "Database: [bold red]CORRUPTED[/bold red]"
    except sqlite3.Error as e:
        return False, f"Database: [bold red]ERROR[/bold red] ({e})"


def check_chrome_automation() -> Tuple[bool, str]:
    """Checks if undetected_chromedriver is importable."""
    try:
        import undetected_chromedriver as uc  # noqa: F401
        return True, "Browser Automation: [bold green]READY[/bold green]"
    except ImportError:
        return False, "Browser Automation: [bold red]NOT READY[/bold red] (pip install undetected-chromedriver)"


def run_diagnostics(config: Dict[str, Any]) -> None:
    """Runs a full suite of system diagnostics including IP leak test."""
    console.print("\n[bold magenta]Running System Pre-flight Check...[/bold magenta]\n")

    results = [
        check_internet(),
        check_ip_address(),
        check_site_reachability("https://annas-archive.gl"),
        check_database(config.get("db_path")),
        check_chrome_automation(),
    ]

    table = Table(show_header=False, box=None)
    for success, message in results:
        icon = "[green]OK[/green]" if success is True else "[red]FAIL[/red]" if success is False else "[yellow]WARN[/yellow]"
        table.add_row(icon, message)

    console.print(Panel(table, title="System Health Report", border_style="cyan"))

    if all(r[0] is not False for r in results):
        console.print("\n[bold green]System is ready for VPN-mode operation![/bold green]")
    else:
        console.print("\n[bold red]Issues detected. Please fix FAIL items before proceeding.[/bold red]")
