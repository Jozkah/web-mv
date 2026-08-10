// web_mv_agent.as — Echo/Angel agent script for web-mv
// Bridges Echo's built-in memory server (process::open_socket) to the web-mv relay.
//
// Workflow:
//   1. Start the relay: run release\bun-server.exe (or run.bat)
//   2. Load this script in Echo/Angel.
//   3. Open http://127.0.0.1:8080/ in your browser.

const string PROCESS_NAME = "HuntGame.exe";              // Target process name
const string GAME_MODULE  = "GameHunt.dll";              // Target module to inspect
const string RELAY_URL    = "ws://localhost:8080/agent"; // Default web-mv relay port (8080)

bool g_attached = false;

void notify(const string &in msg, int r, int g, int b)
{
    print("[web-mv] " + msg);
    alert::show_tag(msg, "webmv", r, g, b);
}

// Attach once; re-attach only if the process died since last time.
bool ensure_attached()
{
    if (g_attached && process::is_alive()) return true;

    attach_data d = process::attach(PROCESS_NAME, true);
    if (d.pid == 0)
    {
        g_attached = false;
        notify("attach FAILED — is " + PROCESS_NAME + " running?", 255, 80, 80);
        return false;
    }
    g_attached = true;

    uint64 modBase = process::get_module_base(GAME_MODULE);
    notify("attached PID " + d.pid + "  " + GAME_MODULE + " @ " + util::to_hex(modBase),
           0, 200, 255);
    return true;
}

void connect()
{
    if (!ensure_attached()) return;

    // open_socket returns false if the relay is unreachable OR a socket is
    // already open (only one connection allowed at a time).
    if (process::open_socket(RELAY_URL))
        notify("relay connected — open http://127.0.0.1:8080/ and browse " + GAME_MODULE,
               80, 255, 120);
    else
        notify("open_socket FAILED — start release\\bun-server.exe, or a socket is already open",
               255, 160, 40);
}

void on_connect_click() { connect(); }

void on_detach_click()
{
    process::detach(); // host closes the socket on detach
    g_attached = false;
    notify("detached", 200, 200, 200);
}

bool main()
{
    ui::add_tab("web-mv");
    ui::add_category("Agent");
    ui::add_button("Attach + connect relay", @on_connect_click);
    ui::add_button("Detach", @on_detach_click);

    connect();
    return true;
}

void on_unload()
{
    process::detach();
}
