# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for San Citro Python bridge
# Bundles bridge.py and all src/ dependencies into a standalone executable

block_cipher = None

from PyInstaller.utils.hooks import collect_all

# Anti-bot deps ship native libs (curl_cffi/libcurl) and data files
# (selenium, undetected_chromedriver) that bare hiddenimports miss — collect all.
_anti_datas, _anti_bins, _anti_hidden = [], [], []
for _pkg in ('curl_cffi', 'undetected_chromedriver', 'selenium'):
    _d, _b, _h = collect_all(_pkg)
    _anti_datas += _d
    _anti_bins += _b
    _anti_hidden += _h

a = Analysis(
    ['bridge.py'],
    pathex=['../..'],  # Project root for src/ imports
    binaries=_anti_bins,
    datas=_anti_datas,
    hiddenimports=[
        'src',
        'src.annas_archive_tool',
        'src.config_manager',
        'src.download_history',
        'src.diagnostics',
        'src.download_strategy',
        'src.download_job',
        'src.scraper',
        'src.logger',
        'src.shutdown',
        'src.utils',
        'src.migrations',
        'src.export',
        'src.audiobook_db',
        'src.audiobook_processor',
        'src.media_tools',
        'audiobook_queue',
        'requests',
        'bs4',
        'zstandard',
        'sqlite3',
        'tqdm',
        # Anti-bot deps required for no-VPN downloads (Chrome strategy + TLS).
        'undetected_chromedriver',
        'selenium',
        'curl_cffi',
    ] + _anti_hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'pytest',
        'mypy',
        'ruff',
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='bridge',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='bridge',
)
