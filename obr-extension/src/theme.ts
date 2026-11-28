import OBR, { type Theme } from '@owlbear-rodeo/sdk';

// Follows Owlbear's light or dark theme, like Draw Steel Tools: the mode in the page's address first (so an
// embed doesn't flash the wrong colours while it loads), then Owlbear's own colours as CSS variables
// (style.css), kept up to date. Outside Owlbear the page stays dark, Owlbear's default.

const root = document.documentElement;

const setMode = (mode: 'DARK' | 'LIGHT') => {
	root.dataset.theme = mode === 'LIGHT' ? 'light' : 'dark';
};

const apply = (theme: Theme) => {
	setMode(theme.mode);
	root.style.setProperty('--paper', theme.background.paper);
	root.style.setProperty('--text', theme.text.primary);
	root.style.setProperty('--text-2', theme.text.secondary);
	root.style.setProperty('--text-off', theme.text.disabled);
	root.style.setProperty('--primary', theme.primary.main);
	root.style.setProperty('--primary-text', theme.primary.contrastText);
};

export const followTheme = () => {
	setMode(new URLSearchParams(window.location.search).get('themeMode') === 'LIGHT' ? 'LIGHT' : 'DARK');
	OBR.onReady(async () => {
		apply(await OBR.theme.getTheme());
		OBR.theme.onChange(apply);
	});
};
