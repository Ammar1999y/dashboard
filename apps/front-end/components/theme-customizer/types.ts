export type ThemeMode = 'light' | 'dark';

export type ThemeStyleProps = {
  background: string;
  foreground: string;
  card: string;
  'card-foreground': string;
  popover: string;
  'popover-foreground': string;
  primary: string;
  'primary-light': string;
  'primary-dark': string;
  'primary-ink': string;
  'primary-foreground': string;
  secondary: string;
  'secondary-hover': string;
  'secondary-foreground': string;
  muted: string;
  'muted-foreground': string;
  accent: string;
  'accent-foreground': string;
  destructive: string;
  'destructive-hover': string;
  'destructive-foreground': string;
  border: string;
  input: string;
  ring: string;
  'chart-1': string;
  'chart-2': string;
  'chart-3': string;
  'chart-4': string;
  'chart-5': string;
  sidebar: string;
  'sidebar-foreground': string;
  'sidebar-primary': string;
  'sidebar-primary-foreground': string;
  'sidebar-accent': string;
  'sidebar-accent-foreground': string;
  'sidebar-border': string;
  'sidebar-ring': string;
  'colors-palette-success-default': string;
  'colors-palette-success-dark': string;
  'colors-palette-warning-default': string;
  'colors-palette-warning-dark': string;
  'colors-palette-error-default': string;
  'colors-palette-error-dark': string;
  'colors-palette-info-default': string;
  'colors-palette-info-dark': string;
  'font-mono': string;
  radius: string;
  spacing: string;
  'shadow-color': string;
  'shadow-opacity': string;
  'shadow-blur': string;
  'shadow-spread': string;
  'shadow-offset-x': string;
  'shadow-offset-y': string;
};

export type ThemeStyles = Record<ThemeMode, ThemeStyleProps>;

export type ThemePreset = {
  label: string;
  createdAt?: string;
  styles: Record<ThemeMode, Partial<ThemeStyleProps>>;
};

export type ThemeEditorState = {
  preset?: string;
  styles: ThemeStyles;
};
