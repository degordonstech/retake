@echo off
REM Start Retake in its own window, without a console.
cd /d "%~dp0"
if not exist "web\dist\index.html" (
  echo Building the interface the first time...
  pushd web
  call npm install
  call npm run build
  popd
)
start "" pythonw -m retake
