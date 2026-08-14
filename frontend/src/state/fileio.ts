// Small browser file helpers for JSON export/import of user data (cheat tables, bookmarks).

export function downloadText(filename: string, text: string): void {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

/** Prompt for a local file and resolve its text, or undefined if cancelled / unreadable. */
export function pickTextFile(): Promise<string | undefined> {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json";
        input.onchange = () => {
            const file = input.files?.[0];
            if (!file) {
                resolve(undefined);
                return;
            }
            const reader = new FileReader();
            reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : undefined);
            reader.onerror = () => resolve(undefined);
            reader.readAsText(file);
        };
        input.click();
    });
}
