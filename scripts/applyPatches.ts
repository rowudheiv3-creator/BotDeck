/* BotDeck: applies our small, reviewable patches on top of the pinned upstream checkouts. */
import { execFileSync } from "child_process";
import path from "path";

const root = process.cwd();
const targets: [string, string][] = [
    ["Vencord", "patches/vencord.patch"],
    ["Vencord/src/userplugins/botClient", "patches/botclient-plugin.patch"],
];

for (const [dir, patch] of targets) {
    const cwd = path.join(root, dir);
    const file = path.join(root, patch);
    try {
        execFileSync("git", ["apply", "--check", "--reverse", file], { cwd, stdio: "ignore" });
        console.log("already applied:", patch);
    } catch {
        execFileSync("git", ["apply", file], { cwd, stdio: "inherit" });
        console.log("applied:", patch);
    }
}
