#!/bin/bash
echo "Compiling CodeOn extension..."
echo ""

# Install dependencies if not present
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
    if [ $? -ne 0 ]; then
        echo "Failed to install dependencies"
        exit 1
    fi
fi

# Compile TypeScript files
echo "Compiling TypeScript files..."
npm run compile
if [ $? -ne 0 ]; then
    echo "Compilation failed"
    exit 1
fi

echo ""
echo "Compilation successful!"
echo "The extension is ready in the 'out' directory."
echo ""
echo "To install in VS Code:"
echo "1. Open VS Code"
echo "2. Press Ctrl+Shift+P"
echo "3. Type 'Developer: Reload Window' and select it"
echo "4. Or use 'Run Extension' configuration"