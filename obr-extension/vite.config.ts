import { defineConfig } from 'vite';

// Owlbear Rodeo fetches manifest.json and the icons cross-origin from its own site
const cors = { origin: /^https:\/\/([a-z0-9-]+\.)*owlbear\.rodeo$/ };

export default defineConfig({
	server: {
		port: 5174,
		strictPort: true,
		cors: cors
	},
	preview: {
		port: 5174,
		strictPort: true,
		cors: cors
	}
});
