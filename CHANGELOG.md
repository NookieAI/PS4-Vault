# What's New in PS4 Vault

---

## Version 1.0.0 — Initial Release

This is the first public release of PS4 Vault.

### Scanning
- Scan any folder or hard drive for PS4/PS5 PKG files
- Automatically reads game names, cover art, version, region and required firmware from each file
- Scan over FTP directly from your PS4/PS5
- See installed games on your console (cover art, file sizes, all game info)
- Partial/incomplete downloads are flagged with a warning so you know which files to re-download
- Drag and drop folders onto the source box to start a scan
- Your library is saved when you close the app and reloaded next time — no need to rescan

### Library
- Table view and grid (cover art) view
- Sort by name, type, version, region, size or filename
- Filter by game type: Game, Patch, DLC, App, Theme, or Installed
- Search by name, CUSA ID or filename
- Duplicate detection — spots and removes identical games
- Export your library as a spreadsheet (CSV) or plain text list

### Copy & Move
- Copy or move games to any folder or USB drive
- FTP transfer directly to/from your console
- Live speed, time remaining and progress bar during transfer
- If a file already exists at the destination, you choose: Skip, Rename (adds _2) or Overwrite — for each file individually or all at once
- "Open Folder" button appears when transfer is done

### Rename
- Rename files one at a time or in bulk
- Choose from preset formats or create your own using tags like `{TITLE}`, `{TITLE_ID}`, `{VERSION}`, `{REGION}`
- Preview shows the new filename before you apply it

### Install to Console
- Send games directly from your PC to your PS4/PS5 over the network
- Works with Remote PKG Installer (RPI) and GoldHEN/etaHEN — detected automatically
- Queue multiple games; PS4 Vault installs them one by one with a short gap between each
- Live progress: connecting → sending command → downloading → complete
- Elapsed timer so you know the app is working during long installs
- Cancel at any time
- Test your connection and network speed before sending

### Console Connection
- Automatically scans your network to find your PS4/PS5 — no need to look up the IP
- Save console profiles so you can switch between multiple consoles
- FTP passive and active mode (some older CFW requires active)
- Custom subnet for large or VPN networks

### Settings
- Scan depth (how deep into subfolders to search)
- Install queue delay (how long to wait between queued installs)
- FTP connection count (how many parallel connections to use when scanning)

### Other
- Dark and light theme (click "Made by Nookie" to switch)
- Covers and metadata always visible — no need to rescan after closing the app
- Full log file for troubleshooting (Menu → View Log File)
- Auto-update: PS4 Vault checks for new versions on startup and prompts you to install them
