# Sync Steel: how to

Sync Steel is our group's copy of Forge Steel at **https://syncsteel.app**. It keeps your heroes in the group's room on our server, so they're on every device you join from and safe if a device is lost. It's an unofficial fork, not made or supported by Forge Steel's author.

## Players: getting started

You need the room's **join code** from the GM (it looks like `ABCDE-12345`).

1. **Export your heroes from forgesteel.net**, on the device that has them. For each hero, open it and choose **Export → Export as Data**. That saves a `.ds-hero` file. If you use homebrew, export each homebrew sourcebook too: **Library → Sourcebooks**, then the sourcebook's **Export** button, which saves a `.ds-sourcebook` file.
2. **Open https://syncsteel.app** and tap **Sync Steel** in the bottom bar.
3. **Join the room:**
   1. Enter the join code and tap **Find room**.
   2. Pick **A new seat** and type your name. If you've joined before on another device, pick **your own seat** instead.
   3. Tap **Join**. The app reloads, connected to the room.
4. **Import your heroes:** **Heroes → Add → Import Hero Files**, and pick your `.ds-hero` files. They save to the room straight away.
5. **Import homebrew:** **Library → Sourcebooks → Import a sourcebook**. Homebrew is shared by the whole room, so only one person needs to import each sourcebook.
6. **On iPad or iPhone:** in Safari, tap **Share → Add to Home Screen**. Use that icon from then on. The installed app and Safari keep separate storage, so join once more inside the installed app (same seat).

Sync Steel needs the internet: your heroes live on the server, not on the device.

## Players: a new or lost device

- **New device:** open https://syncsteel.app → **Sync Steel** → join with the code → pick **your own seat**. Your heroes load.
- **Lost device:** tell the GM, who disconnects it in the GM tools. Then join from your new device as above.
- **"Data load error … This device has been removed from the room":** this device was disconnected, or the server was reset. On that screen, open **Forge Steel Warehouse Settings**, turn off **Manually connect with Forge Steel Warehouse**, tap **Save**, then join again with the code.

## GM

### Creating the room (once)

1. Open https://syncsteel.app → **Sync Steel** → **Create a room (GM)**.
2. Enter a room name and tap **Create room**.
3. **Save both codes now; they can't be shown again:**
   - the **join code**, for the players;
   - the **GM key**, in your password manager. You need it to add another GM device, and it can never be changed or recovered.
4. Tick the box and tap **Continue**. This device joins the GM's seat.

### Another GM device

**Sync Steel → I'm the GM, adding a device** → enter the GM key. The join code isn't needed.

### GM tools

They're on the **Sync Steel** page on any GM device. The GM sees every player's heroes.

- **Backups → Download export:** a copy of the whole room (every seat, hero and homebrew sourcebook) as a `.json.gz` file. **Download one after each session** and keep it somewhere outside the server. The page warns when the last export is more than a week old.
- **Backups → Restore from an export:** pick an export file. You'll see what would change before anything does. A restore never deletes anything, and heroes added since the export stay.
- **Daily snapshots:** the server keeps a copy of each of the last 14 days. **Restore…** works like restoring an export.
- **Join code → New join code:** if the code was lost or shared too widely. Devices that already joined stay signed in.
- **Seats and devices:**
  - rename a seat by clicking the pencil next to its name;
  - **Disconnect** a lost or old device. Its seat and heroes stay, and the player can join again.

### If the server is lost entirely

Create a new room, then **Restore from an export** with your latest export file. Give the players the new join code; each picks their seat again.
