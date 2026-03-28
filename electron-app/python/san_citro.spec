# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for San Citro Python bridge
# Bundles bridge.py and all src/ dependencies into a standalone executable

block_cipher = None

a = Analysis(
    ['bridge.py'],
    pathex=['../..'],  # Project root for src/ imports
    binaries=[],
    datas=[],
    hiddenimports=[
        'src',
        'src.annas_archive_tool',
        'src.config_manager',
        'src.search_local',
        'src.download_history',
        'src.ingest_db',
        'src.diagnostics',
        'src.download_strategy',
        'src.logger',
        'src.shutdown',
        'src.utils',
        'src.migrations',
        'src.export',
        'requests',
        'bs4',
        'zstandard',
        'sqlite3',
        'tqdm',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'undetected_chromedriver',
        'selenium',
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
