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

## Live updates

While you're connected to the room, a change saved on one device shows up on the others within a second or so, without reloading. That includes the GM's changes to your hero, and yours on the GM's screen.

- **The dot on the Sync Steel button** shows the connection: **green** when live, **grey** while it reconnects. An iPad or phone reconnects by itself when you come back to the app.
- **Two people changing the same hero at once is fine.** Changes to different things are both kept. Stamina, temporary stamina, recoveries, surges and heroic resources add up, so damage you take while the GM adds temporary stamina counts both. For anything else changed in both places at once, the later save wins.
- **Open panels refresh themselves.** The **Resources**, **Vitals** and **Inventory** panels show changes made on another device or in Owlbear while they're open. The hero editor doesn't: close it and open it again to see them. Changes you make anywhere still save correctly.
  - To go back to Forge Steel's original panels, turn off **Live panels** on the Sync Steel page, under "This device". They then show other devices' changes only once reopened.

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

### Owlbear

The **Sync Steel** Owlbear extension shows each hero's stamina, recoveries, surges, heroic resource and conditions on their **Draw Steel Tools** token, and keeps the token and Forge Steel in step both ways. Set it up once, on the GM's laptop:

1. **Add the extension:** in the Owlbear room, open **Extensions → Add custom extension** and enter `https://syncsteel.app/owlbear/manifest.json`.
2. **Connect the room:** on the Sync Steel page, open **GM tools → Owlbear → Connect Owlbear**, and copy the connection it shows. In Owlbear, open the **Sync Steel** button in the toolbar, paste it and press **Connect**. The connection is shown only once; if you lose it, make a new one (the old one stops working).
3. **Link each hero's token:** right-click the token → **Link to hero**, and pick the hero. Heroes whose name matches the token are at the top. The link stays on the token, so you link once even if you move it between scenes. To link a token to a different hero, choose **Unlink from hero** first.

**At the table:**
- **Changes in Forge Steel show on the token** within a few seconds: damage, temporary stamina, recoveries, surges, heroic resources and conditions.
- **Changes on the token reach Forge Steel too.** Change stamina, temporary stamina, recoveries, surges or the heroic resource in Draw Steel Tools, and the hero's sheet follows within a few seconds.
  - If someone changed the same hero in Forge Steel at the same moment, both changes count: 3 damage on the token and 5 in Forge Steel make 8.
  - The name, maximum stamina and resource name come from Forge Steel only; change those there.
  - If a change can't be saved, Owlbear says so and the token goes back to what Forge Steel has.
  - **An open Resources, Vitals or Inventory panel in Forge Steel** shows the change straight away (unless **Live panels** is off).
- **Conditions** show as small labels at the token's top-left, such as "Bleeding (EoT)".
  - They look and stack like the **Token Labels** extension's, so labels you add with Token Labels sit in the same stack.
  - Players don't see them on tokens you've hidden.
  - **To add or remove one:** right-click the token. The **Conditions** panel in its menu has a chip for each of Draw Steel's nine conditions: click one to add it, click a filled one to remove it. Pick **EoT**, **SE** or **Until removed** above the chips first; your last choice is remembered.
  - **Several tokens at once:** select them all (drag a box, or Shift-click), then right-click one. A chip is filled when every selected token has that condition, and half filled when only some do. Clicking a half-filled chip adds it to the rest.
  - **Any token, linked or not:** monsters and other unlinked tokens keep conditions of their own on the token. A linked token's conditions are the hero's, so changing them changes Forge Steel.
  - **Custom conditions, and removing just one:** click **⋯** in the panel, or open the **Sync Steel** button in the toolbar. Its **Conditions** tab lists each selected token's conditions with an ✕ each, and has a box for a custom condition.
  - **Clearing up:** with nothing selected, the **Conditions** tab lists every token in the scene that has a condition. Click a name to select that token. **Clear End of turn** removes every EoT condition in the scene at once.
  - Anyone in the Owlbear room can add and remove conditions.
  - **Deleting a label in Owlbear doesn't remove the condition.** The label comes back while the token has it.
  - **Linking a token to a hero** replaces any conditions the token had of its own with the hero's.
- **The popover** has two tabs: **Conditions** (above), and **Sync Steel**. The Sync Steel tab shows whether the room is connected, which device is updating the tokens (yours, while you're in the room) and every linked token in the scene.
- **To stop:** right-click a token → **Unlink from hero**, or **Disconnect this room** in the popover. Tokens keep the stats they show.

### If the server is lost entirely

Create a new room, then **Restore from an export** with your latest export file. Give the players the new join code; each picks their seat again. Then connect Owlbear again (GM tools → Owlbear); token links survive, because hero ids don't change.
