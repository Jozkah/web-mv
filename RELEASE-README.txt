Run run.bat (starts bun-server.exe and opens http://127.0.0.1:8080/). Runs on localhost only.
After attaching the target process, bind it to the server with: process::open_socket("ws://localhost:8080/agent");
