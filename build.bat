@echo off
echo Compiling CodeOn extension...
echo.

REM Install dependencies if not present
if not exist node_modules (
    echo Installing dependencies...
    npm install
    if %ERRORLEVEL% NEQ 0 (
        echo Failed to install dependencies
        exit /b 1
    )
)

REM Compile TypeScript files
echo Compiling TypeScript files...
npm run compile
if %ERRORLEVEL% NEQ 0 (
    echo Compilation failed
    exit /b 1
)

echo.
echo Compilation successful!
echo The extension is ready in the 'out' directory.
echo.
echo To install in VS Code:
echo 1. Open VS Code
echo 2. Press Ctrl+Shift+P
echo 3. Type "Developer: Reload Window" and select it
echo 4. Or use "Run Extension" configuration