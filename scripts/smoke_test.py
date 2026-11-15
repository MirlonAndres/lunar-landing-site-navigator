"""
Lunar Landing Site Navigator - Environment Smoke Test
Test de Verificacion del Entorno - Lunar Landing Site Navigator
NASA Space Apps Challenge 2026

English:
Verifies that all required scientific, asynchronous API, and telemetry packages
are correctly installed and importable. Also confirms that the modular directory
architecture and configuration templates exist.

Espanol:
Verifica que todos los paquetes cientificos, de API asincrona y de telemetria
esten correctamente instalados y sean importables. Confirma ademas la existencia
de la arquitectura modular de directorios y plantillas de configuracion.
"""

import sys
import os
from pathlib import Path


def verify_imports() -> bool:
    """
    English: Import all mission-critical dependencies and report status.
    Espanol: Importar todas las dependencias criticas de mision y reportar estado.
    """
    print("==============================================================================")
    print("1. VERIFYING PYTHON DEPENDENCIES / VERIFICANDO DEPENDENCIAS DE PYTHON")
    print("==============================================================================")

    dependencies = [
        ("numpy", "NumPy Numerical Arrays / Arrays Numericos"),
        ("scipy", "SciPy Scientific Processing / Procesamiento Cientifico"),
        ("pandas", "Pandas Ephemeris DataFrames / Tablas de Efemerides"),
        ("pyarrow", "PyArrow Columnar Storage / Almacenamiento Columnar Parquet"),
        ("tifffile", "Tifffile NASA LOLA GeoTIFF Parser / Lector GeoTIFF LOLA"),
        ("requests", "Requests HTTP Client / Cliente HTTP"),
        ("fastapi", "FastAPI Asynchronous Framework / Framework Asincrono"),
        ("uvicorn", "Uvicorn ASGI Web Server / Servidor Web ASGI"),
        ("websockets", "WebSockets Real-Time Protocol / Protocolo Tiempo Real"),
        ("pydantic", "Pydantic Schema Validation / Validacion de Esquemas"),
        ("dotenv", "Python Dotenv Environment Loader / Gestor de Entorno"),
    ]

    all_passed = True
    for module_name, description in dependencies:
        try:
            mod = __import__(module_name)
            version = getattr(mod, "__version__", "loaded")
            print(f"[OK] {description} ({module_name} v{version})")
        except ImportError as exc:
            print(f"[FAIL] {description} ({module_name}): {exc}")
            all_passed = False

    return all_passed


def verify_directories(root_dir: Path) -> bool:
    """
    English: Confirm that all modular architecture directories exist.
    Espanol: Confirmar que todos los directorios de la arquitectura modular existen.
    """
    print("\n==============================================================================")
    print("2. VERIFYING MODULAR DIRECTORIES / VERIFICANDO DIRECTORIOS MODULARES")
    print("==============================================================================")

    required_dirs = [
        "data/raw",
        "data/processed",
        "src/core",
        "src/api",
        "src/dashboard",
        "firmware/esp32_s3_arm",
        "scripts",
        "docs",
    ]

    all_passed = True
    for rel_path in required_dirs:
        dir_path = root_dir / rel_path
        if dir_path.is_dir():
            print(f"[OK] Directory exists / Directorio existe: {rel_path}")
        else:
            print(f"[FAIL] Directory missing / Directorio faltante: {rel_path}")
            all_passed = False

    return all_passed


def verify_config_files(root_dir: Path) -> bool:
    """
    English: Confirm presence of baseline configuration and tracking files.
    Espanol: Confirmar presencia de archivos de configuracion base y seguimiento.
    """
    print("\n==============================================================================")
    print("3. VERIFYING CONFIGURATION FILES / VERIFICANDO ARCHIVOS DE CONFIGURACION")
    print("==============================================================================")

    required_files = [
        ".gitignore",
        "PROJECT_LOG.md",
        "requirements.txt",
        ".env.example",
    ]

    all_passed = True
    for rel_path in required_files:
        file_path = root_dir / rel_path
        if file_path.is_file():
            print(f"[OK] File exists / Archivo existe: {rel_path}")
        else:
            print(f"[FAIL] File missing / Archivo faltante: {rel_path}")
            all_passed = False

    return all_passed


def verify_scientific_computation() -> bool:
    """
    English: Execute basic NumPy and SciPy operations to verify numerical pipeline.
    Espanol: Ejecutar operaciones basicas de NumPy y SciPy para verificar el pipeline numerico.
    """
    print("\n==============================================================================")
    print("4. VERIFYING NUMERICAL COMPUTATION / VERIFICANDO COMPUTO NUMERICO")
    print("==============================================================================")

    try:
        import numpy as np
        from scipy import ndimage

        # Simulate small 10x10 elevation grid
        # Simular cuadrícula de elevacion de 10x10
        elevation_grid = np.array([
            [10.0, 10.5, 11.0, 11.2, 11.5, 12.0, 12.3, 12.8, 13.0, 13.5],
            [10.2, 10.6, 11.1, 11.4, 11.8, 12.2, 12.5, 12.9, 13.2, 13.7],
            [10.5, 10.8, 11.3, 11.7, 12.0, 12.4, 12.8, 13.1, 13.5, 14.0],
            [10.7, 11.0, 11.5, 11.9, 12.3, 12.7, 13.0, 13.4, 13.8, 14.2],
            [11.0, 11.3, 11.8, 12.2, 12.6, 13.0, 13.3, 13.7, 14.1, 14.5],
            [11.2, 11.5, 12.0, 12.4, 12.8, 13.2, 13.6, 14.0, 14.3, 14.8],
            [11.5, 11.8, 12.3, 12.7, 13.1, 13.5, 13.9, 14.2, 14.6, 15.0],
            [11.8, 12.1, 12.5, 12.9, 13.3, 13.7, 14.1, 14.5, 14.8, 15.3],
            [12.0, 12.3, 12.8, 13.2, 13.6, 14.0, 14.4, 14.7, 15.1, 15.5],
            [12.3, 12.6, 13.0, 13.4, 13.8, 14.2, 14.6, 15.0, 15.3, 15.8],
        ], dtype=np.float32)

        # Compute gradient (Sobel filter)
        # Calcular gradiente (filtro Sobel)
        dx = ndimage.sobel(elevation_grid, axis=1) / 8.0
        dy = ndimage.sobel(elevation_grid, axis=0) / 8.0
        slope = np.degrees(np.arctan(np.sqrt(dx**2 + dy**2)))

        mean_slope = float(np.mean(slope))
        print(f"[OK] Scientific pipeline functional. Mean test slope: {mean_slope:.2f} deg")
        print(f"[OK] Pipeline cientifico funcional. Pendiente promedio de prueba: {mean_slope:.2f} deg")
        return True
    except Exception as exc:
        print(f"[FAIL] Numerical verification error / Error en verificacion numerica: {exc}")
        return False


def main():
    """
    Main execution entry point.
    Punto de entrada principal de ejecucion.
    """
    root_dir = Path(__file__).resolve().parent.parent

    print("==============================================================================")
    print("LUNAR LANDING SITE NAVIGATOR - SMOKE TEST SUITE")
    print("SUITE DE PRUEBAS DE HUMO - LUNAR LANDING SITE NAVIGATOR")
    print(f"Workspace / Espacio de Trabajo: {root_dir}")
    print("==============================================================================\n")

    imports_ok = verify_imports()
    dirs_ok = verify_directories(root_dir)
    configs_ok = verify_config_files(root_dir)
    science_ok = verify_scientific_computation()

    print("\n==============================================================================")
    print("SMOKE TEST SUMMARY / RESUMEN DE PRUEBAS DE HUMO")
    print("==============================================================================")

    all_passed = imports_ok and dirs_ok and configs_ok and science_ok
    if all_passed:
        print("[PASS] ALL SYSTEMS OPERATIONAL / TODOS LOS SISTEMAS OPERATIVOS")
        print("Ready to proceed to Phase 2: NASA Data Ingestion.")
        print("Listo para avanzar a la Fase 2: Ingesta de Datos de la NASA.")
        sys.exit(0)
    else:
        print("[FAIL] ONE OR MORE CHECKS FAILED / UNA O MAS PRUEBAS FALLARON")
        sys.exit(1)


if __name__ == "__main__":
    main()
