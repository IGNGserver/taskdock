/**
 * TaskDock Material 3 Expressive component library.
 *
 * Everything the pages render comes from here so that the expressive shape,
 * motion and state-layer rules are defined exactly once. Pages compose these
 * primitives; they must not restyle them from page CSS.
 */

export {
  Button,
  IconButton,
  ButtonGroup,
  SplitButton,
  Menu,
  Fab,
  FabMenu,
  ChevronGlyph,
  CloseGlyph,
  joinClasses,
  type ButtonVariant,
  type ButtonSize,
  type ButtonShape,
  type IconButtonVariant,
  type IconButtonSize,
  type ButtonGroupOption,
  type MenuOption,
  type FabMenuItem,
  type FabSize,
  type FabVariant,
} from './button.js';

export {
  TextField,
  TextArea,
  Select,
  SelectField,
  Chip,
  Switch,
  CheckGlyph,
  ChevronDown,
  type FieldVariant,
  type SelectOption,
  type ChipKind,
} from './field.js';

export {
  Card,
  List,
  ListItem,
  Badge,
  LinearProgress,
  LoadingIndicator,
  Snackbar,
  BottomSheet,
  Dialog,
  ConfirmDialog,
  SideSheet,
  Tooltip,
  Toolbar,
  type SheetSize,
  type SnackbarAction,
  type DialogState,
} from './container.js';

export {
  NavigationBar,
  NavigationRail,
  NavigationDrawer,
  TopAppBar,
  SearchBar,
  type NavigationDestination,
  type AppBarVariant,
} from './navigation.js';

export {
  usePresence,
  useWindowSizeClass,
  useDismissibleMenu,
  useRovingFocus,
  useFocusTrap,
  useScrollLock,
  useRovingFocus as useRovingTabIndex,
  windowSizeClass,
  isCompactShell,
  prefersReducedMotion,
  haptic,
  SPRING_DURATION,
  type PresenceState,
  type WindowSizeClass,
  type SpringSpeed,
} from './behavior.js';
