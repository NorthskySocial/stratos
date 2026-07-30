interface ThemeState {
  dark: boolean
}

export const theme: ThemeState = $state({
  dark: document.documentElement.classList.contains('dark'),
})

export function toggleTheme(): void {
  theme.dark = !theme.dark
  localStorage.theme = theme.dark ? 'dark' : 'light'
  document.documentElement.classList.toggle('dark', theme.dark)
}
