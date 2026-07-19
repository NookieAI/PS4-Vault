<p align="center">
  <img src="assets/logo.jpg" width="100" alt="PS4 Vault" style="border-radius:12px"/>
</p>

<h1 align="center">PS4 Vault</h1>

<p align="center">
  The easiest way to manage your PS4 PKG collection on Windows
</p>

<p align="center">
  <a href="https://github.com/NookieAI/PS4-Vault/releases/latest">Download</a> ·
  <a href="https://discord.gg/nj45kDSBEd">Discord</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  <a href="https://github.com/NookieAI/PS4-Vault/releases/latest"><img src="https://img.shields.io/github/v/release/NookieAI/PS4-Vault?label=latest&color=00d4ff" alt="Latest Release"></a>
  <a href="https://github.com/NookieAI/PS4-Vault/releases"><img src="https://img.shields.io/github/downloads/NookieAI/PS4-Vault/total?color=00d4ff" alt="Downloads"></a>
</p>

---

## What is PS4 Vault?

PS4 Vault is a free Windows app for browsing, organising and installing PS4 PKG files — all from one clean interface.

Whether you have games spread across multiple hard drives, want to copy them to a USB drive, or send them directly to your console over Wi-Fi, PS4 Vault handles it.

---

## Features

**Find your games**
- Scan any folder or hard drive and it automatically finds all your PKG files
- Shows the game name, cover art, version, region and file size for every game
- Remembers your library between sessions — no rescanning every time you open it
- Drag and drop a folder onto the source box to scan it instantly

**Organise your collection**
- Copy or move games to a new location with live speed and time-remaining display
- Rename files in bulk using your own format (e.g. `CUSA12345 - Game Name v1.00`)
- Spot and remove duplicate files with one click

**Connect to your console**
- Connects to your PS4 or PS5 over your home network (Wi-Fi or cable)
- See every game currently installed on your console, with cover art and storage used
- Scan the console for PKG files stored on USB drives

**Install games to your console**
- Send games directly from your PC to your PS4/PS5 — no USB drive needed
- Works with Remote PKG Installer (RPI) and GoldHEN/etaHEN
- Automatically detects which installer your console is running
- Queue multiple games and they install one after another
- Live progress bar showing download speed and time remaining on your console

**Extras**
- Test your network speed to the console before installing
- Auto-discovers your console on the network — no need to look up the IP address
- Saves console profiles so you can switch between PS4 and PS5 easily
- Dark and light theme (click "Made by Nookie" to toggle)
- Auto-update — PS4 Vault checks for new versions on startup and updates itself silently

---

## Requirements

- Windows 10 or Windows 11 (64-bit)
- A PS4 or PS5 with a jailbreak (GoldHEN, etaHEN, or similar)
- For remote install: Remote PKG Installer must be open on your console

---

## Getting Started

1. Download `PS4 Vault.exe` from the [Releases page](https://github.com/NookieAI/PS4-Vault/releases/latest) and run it — no installation needed
2. Click the folder icon next to **SOURCE** and pick where your PKG files are
3. Click **SCAN** — your games will appear with cover art in a few seconds
4. To install to your console, select a game and click **Install to PS4/PS5**

---

## Installing Games to Your Console

1. Make sure your PS4/PS5 is on the same Wi-Fi or network as your PC
2. Open **Remote PKG Installer** on your console and keep it in the foreground
3. In PS4 Vault, select one or more games from the list
4. Click **Install to PS4/PS5** in the toolbar
5. Enter your console's IP address (or click **Find Console** to detect it automatically)
6. Click **Send to PS4/PS5** — the game will appear in your console's download queue

> **Tip:** If you're not sure of your console's IP, go to Settings → Network → View Connection Status on your PS4/PS5.

---

## Scanning Games on Your Console

1. Click the **🎮 PS4/PS5** button in the toolbar
2. Enter your console's IP address (or click Find Console)
3. Click **Installed Games**

PS4 Vault will read the game list directly from your console and show covers, file sizes and version numbers.

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+A` | Select all games |
| `Ctrl+F` | Search |
| `Enter` | Install selected games |
| `Delete` | Delete selected files |
| `Esc` | Clear selection |
| `?` | Show all shortcuts |
| Double-click | Install that game |
| Right-click | More options |

---

## Troubleshooting

Check the log file — it records everything:

**Menu → 📋 View Log File**

Or find it at: `C:\Users\YourName\AppData\Roaming\PS4Vault\ps4vault.log`

For help, share the log file on Discord.

---

## Discord

[Join the Discord](https://discord.gg/nj45kDSBEd) for help, updates and to share your setup.

---

## Building from Source

```bash
git clone https://github.com/NookieAI/PS4-Vault.git
cd PS4-Vault
npm install
npm start          # run in development
npm run build      # build portable .exe
```

---

## Credits

Made by **Nookie**

---

*PS4 Vault is a file management tool. It does not include or distribute game files.*
