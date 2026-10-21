/**
 * Иконки приложения (decision-73): набор Phosphor (regular) вместо lucide.
 *
 * Компоненты экспортируются под прежними именами (X, RefreshCw, FolderGit2 …), поэтому в коде
 * меняется только строка импорта. Размер и цвет задаются классами Tailwind, как раньше
 * (`className="w-4 h-4 text-slate-400"`); класс `fill-*` включает закрашенный вариант
 * (например, звезда избранного). Новые иконки добавляйте сюда, а не импортируйте из пакета напрямую,
 * чтобы набор оставался единым.
 */
import React from 'react';
import type { Icon as PhosphorIcon, IconProps } from '@phosphor-icons/react';
import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  ArrowDownIcon,
  ArrowElbowDownLeftIcon,
  ArrowElbowDownRightIcon,
  ArrowLeftIcon,
  ArrowLineDownIcon,
  ArrowLineUpIcon,
  ArrowRightIcon,
  ArrowSquareOutIcon,
  ArrowUpIcon,
  ArrowsClockwiseIcon,
  ArrowsInIcon,
  ArrowsLeftRightIcon,
  ArrowsOutIcon,
  AsteriskIcon,
  AtIcon,
  BankIcon,
  BellIcon,
  BellRingingIcon,
  BellSlashIcon,
  BookOpenIcon,
  BookmarkSimpleIcon,
  BrainIcon,
  BroadcastIcon,
  CalendarIcon,
  CameraIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CaretUpIcon,
  ChartBarIcon,
  ChatCircleIcon,
  CheckCircleIcon,
  CheckIcon,
  CheckSquareIcon,
  ChecksIcon,
  CircleDashedIcon,
  CircleIcon,
  CircleNotchIcon,
  ClipboardTextIcon,
  ClockCounterClockwiseIcon,
  ClockIcon,
  CloudArrowDownIcon,
  CloudArrowUpIcon,
  CodeIcon,
  ColumnsIcon,
  CopyIcon,
  CpuIcon,
  CurrencyDollarIcon,
  DatabaseIcon,
  DeviceMobileIcon,
  DiceFiveIcon,
  DotOutlineIcon,
  DotsSixVerticalIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  EraserIcon,
  EyeIcon,
  EyeSlashIcon,
  FileArchiveIcon,
  FileCodeIcon,
  FileIcon,
  FileJsIcon,
  FileTextIcon,
  FireIcon,
  FlaskIcon,
  FloppyDiskIcon,
  FlowArrowIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FolderSimpleIcon,
  FoldersIcon,
  GaugeIcon,
  GavelIcon,
  GearIcon,
  GearSixIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitDiffIcon,
  GitForkIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  GithubLogoIcon,
  GlobeIcon,
  GraphIcon,
  HardDriveIcon,
  HardDrivesIcon,
  HeadphonesIcon,
  HouseIcon,
  ImageBrokenIcon,
  ImageIcon,
  InfoIcon,
  KanbanIcon,
  KeyIcon,
  KeyboardIcon,
  LaptopIcon,
  LightbulbIcon,
  LightningIcon,
  LinkBreakIcon,
  LinkIcon,
  ListChecksIcon,
  ListIcon,
  ListPlusIcon,
  LockIcon,
  LockOpenIcon,
  MagicWandIcon,
  MagnifyingGlassIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
  MicrophoneIcon,
  MicrophoneSlashIcon,
  MonitorIcon,
  NavigationArrowIcon,
  PackageIcon,
  PaperPlaneRightIcon,
  PaperPlaneTiltIcon,
  PauseIcon,
  PencilSimpleIcon,
  PencilSimpleLineIcon,
  PlayCircleIcon,
  PlayIcon,
  PlugsConnectedIcon,
  PlusIcon,
  PowerIcon,
  ProhibitIcon,
  PulseIcon,
  QrCodeIcon,
  QuestionIcon,
  QuotesIcon,
  RepeatIcon,
  RobotIcon,
  RocketLaunchIcon,
  ScrollIcon,
  ShareNetworkIcon,
  ShieldCheckIcon,
  ShieldIcon,
  ShieldWarningIcon,
  ShuffleIcon,
  SidebarSimpleIcon,
  SignOutIcon,
  SkipForwardIcon,
  SlidersHorizontalIcon,
  SlidersIcon,
  SparkleIcon,
  SpeakerHighIcon,
  SpeakerSimpleHighIcon,
  SpeakerSlashIcon,
  SquareIcon,
  SquaresFourIcon,
  StackIcon,
  StarIcon,
  TagIcon,
  TargetIcon,
  TerminalIcon,
  TerminalWindowIcon,
  TextAlignJustifyIcon,
  TextAlignLeftIcon,
  TextBIcon,
  TextHIcon,
  TextItalicIcon,
  TrashIcon,
  TreeStructureIcon,
  TrendUpIcon,
  TrophyIcon,
  UploadSimpleIcon,
  UserCheckIcon,
  UserIcon,
  UserMinusIcon,
  UsersIcon,
  WarningCircleIcon,
  WarningIcon,
  WifiHighIcon,
  WifiSlashIcon,
  WrenchIcon,
  XCircleIcon,
  XIcon
} from '@phosphor-icons/react';

export type AppIconProps = Omit<IconProps, 'weight'> & {
  /** Совместимость с прежним API lucide: толщина линии у Phosphor задаётся весом, проп игнорируется */
  strokeWidth?: number | string;
  weight?: IconProps['weight'];
};

const SIZE_CLASS = /(?:^|\s)(?:w|h|size)-/;
const FILL_CLASS = /(?:^|\s)fill-(?!none)/;

const wrap = (Icon: PhosphorIcon, displayName: string) => {
  const Wrapped = React.forwardRef<SVGSVGElement, AppIconProps>(({ className, strokeWidth: _strokeWidth, weight, size, ...rest }, ref) => {
    const cls = className ?? '';
    return (
      <Icon
        ref={ref}
        className={className}
        weight={weight ?? (FILL_CLASS.test(cls) ? 'fill' : 'regular')}
        size={size ?? (SIZE_CLASS.test(cls) ? undefined : 16)}
        aria-hidden={rest['aria-label'] ? undefined : true}
        {...rest}
      />
    );
  });
  Wrapped.displayName = displayName;
  return Wrapped;
};

export const Activity = wrap(PulseIcon, 'Activity');
export const AlertCircle = wrap(WarningCircleIcon, 'AlertCircle');
export const AlertTriangle = wrap(WarningIcon, 'AlertTriangle');
export const AlignJustify = wrap(TextAlignJustifyIcon, 'AlignJustify');
export const AlignLeft = wrap(TextAlignLeftIcon, 'AlignLeft');
export const ArrowDown = wrap(ArrowDownIcon, 'ArrowDown');
export const ArrowDownToLine = wrap(ArrowLineDownIcon, 'ArrowDownToLine');
export const ArrowLeft = wrap(ArrowLeftIcon, 'ArrowLeft');
export const ArrowRight = wrap(ArrowRightIcon, 'ArrowRight');
export const ArrowRightLeft = wrap(ArrowsLeftRightIcon, 'ArrowRightLeft');
export const ArrowUp = wrap(ArrowUpIcon, 'ArrowUp');
export const ArrowUpFromLine = wrap(ArrowLineUpIcon, 'ArrowUpFromLine');
export const Asterisk = wrap(AsteriskIcon, 'Asterisk');
export const At = wrap(AtIcon, 'At');
export const Ban = wrap(ProhibitIcon, 'Ban');
export const BarChart2 = wrap(ChartBarIcon, 'BarChart2');
export const Bell = wrap(BellIcon, 'Bell');
export const BellOff = wrap(BellSlashIcon, 'BellOff');
export const BellRing = wrap(BellRingingIcon, 'BellRing');
export const Bold = wrap(TextBIcon, 'Bold');
export const BookOpen = wrap(BookOpenIcon, 'BookOpen');
export const Bookmark = wrap(BookmarkSimpleIcon, 'Bookmark');
export const Bot = wrap(RobotIcon, 'Bot');
export const Brain = wrap(BrainIcon, 'Brain');
export const BrainCircuit = wrap(BrainIcon, 'BrainCircuit');
export const Calendar = wrap(CalendarIcon, 'Calendar');
export const Camera = wrap(CameraIcon, 'Camera');
export const Check = wrap(CheckIcon, 'Check');
export const CheckCheck = wrap(ChecksIcon, 'CheckCheck');
export const CheckCircle = wrap(CheckCircleIcon, 'CheckCircle');
export const CheckCircle2 = wrap(CheckCircleIcon, 'CheckCircle2');
export const CheckSquare = wrap(CheckSquareIcon, 'CheckSquare');
export const ChevronDown = wrap(CaretDownIcon, 'ChevronDown');
export const ChevronLeft = wrap(CaretLeftIcon, 'ChevronLeft');
export const ChevronRight = wrap(CaretRightIcon, 'ChevronRight');
export const ChevronUp = wrap(CaretUpIcon, 'ChevronUp');
export const Circle = wrap(CircleIcon, 'Circle');
export const CircleDashed = wrap(CircleDashedIcon, 'CircleDashed');
export const CircleDot = wrap(DotOutlineIcon, 'CircleDot');
export const ClipboardCheck = wrap(ClipboardTextIcon, 'ClipboardCheck');
export const Clock = wrap(ClockIcon, 'Clock');
export const CloudDownload = wrap(CloudArrowDownIcon, 'CloudDownload');
export const Code = wrap(CodeIcon, 'Code');
export const Code2 = wrap(CodeIcon, 'Code2');
export const Columns = wrap(ColumnsIcon, 'Columns');
export const Copy = wrap(CopyIcon, 'Copy');
export const CornerDownLeft = wrap(ArrowElbowDownLeftIcon, 'CornerDownLeft');
export const CornerDownRight = wrap(ArrowElbowDownRightIcon, 'CornerDownRight');
export const Cpu = wrap(CpuIcon, 'Cpu');
export const Database = wrap(DatabaseIcon, 'Database');
export const Dices = wrap(DiceFiveIcon, 'Dices');
export const DollarSign = wrap(CurrencyDollarIcon, 'DollarSign');
export const Download = wrap(DownloadSimpleIcon, 'Download');
export const Edit2 = wrap(PencilSimpleIcon, 'Edit2');
export const Edit3 = wrap(PencilSimpleLineIcon, 'Edit3');
export const Eraser = wrap(EraserIcon, 'Eraser');
export const ExternalLink = wrap(ArrowSquareOutIcon, 'ExternalLink');
export const Eye = wrap(EyeIcon, 'Eye');
export const EyeOff = wrap(EyeSlashIcon, 'EyeOff');
export const File = wrap(FileIcon, 'File');
export const FileArchive = wrap(FileArchiveIcon, 'FileArchive');
export const FileCode = wrap(FileCodeIcon, 'FileCode');
export const FileCode2 = wrap(FileCodeIcon, 'FileCode2');
export const FileDiff = wrap(GitDiffIcon, 'FileDiff');
export const FileJson = wrap(FileJsIcon, 'FileJson');
export const FileText = wrap(FileTextIcon, 'FileText');
export const Flame = wrap(FireIcon, 'Flame');
export const FlaskConical = wrap(FlaskIcon, 'FlaskConical');
export const Folder = wrap(FolderIcon, 'Folder');
export const FolderGit2 = wrap(FolderSimpleIcon, 'FolderGit2');
export const FolderKanban = wrap(FoldersIcon, 'FolderKanban');
export const FolderOpen = wrap(FolderOpenIcon, 'FolderOpen');
export const FolderPlus = wrap(FolderPlusIcon, 'FolderPlus');
export const FolderSearch = wrap(MagnifyingGlassIcon, 'FolderSearch');
export const FolderTree = wrap(TreeStructureIcon, 'FolderTree');
export const Gauge = wrap(GaugeIcon, 'Gauge');
export const Gavel = wrap(GavelIcon, 'Gavel');
export const GitBranch = wrap(GitBranchIcon, 'GitBranch');
export const GitCommit = wrap(GitCommitIcon, 'GitCommit');
export const GitFork = wrap(GitForkIcon, 'GitFork');
export const GitMerge = wrap(GitMergeIcon, 'GitMerge');
export const GitPullRequest = wrap(GitPullRequestIcon, 'GitPullRequest');
export const Github = wrap(GithubLogoIcon, 'Github');
export const Globe = wrap(GlobeIcon, 'Globe');
export const GripVertical = wrap(DotsSixVerticalIcon, 'GripVertical');
export const HardDrive = wrap(HardDriveIcon, 'HardDrive');
export const Heading = wrap(TextHIcon, 'Heading');
export const Headphones = wrap(HeadphonesIcon, 'Headphones');
export const HelpCircle = wrap(QuestionIcon, 'HelpCircle');
export const History = wrap(ClockCounterClockwiseIcon, 'History');
export const Home = wrap(HouseIcon, 'Home');
export const Image = wrap(ImageIcon, 'Image');
export const ImageOff = wrap(ImageBrokenIcon, 'ImageOff');
export const Info = wrap(InfoIcon, 'Info');
export const Italic = wrap(TextItalicIcon, 'Italic');
export const Kanban = wrap(KanbanIcon, 'Kanban');
export const Key = wrap(KeyIcon, 'Key');
export const KeyRound = wrap(KeyIcon, 'KeyRound');
export const Keyboard = wrap(KeyboardIcon, 'Keyboard');
export const Landmark = wrap(BankIcon, 'Landmark');
export const Laptop = wrap(LaptopIcon, 'Laptop');
export const Layers = wrap(StackIcon, 'Layers');
export const LayoutGrid = wrap(SquaresFourIcon, 'LayoutGrid');
export const Lightbulb = wrap(LightbulbIcon, 'Lightbulb');
export const Link2 = wrap(LinkIcon, 'Link2');
export const List = wrap(ListIcon, 'List');
export const ListChecks = wrap(ListChecksIcon, 'ListChecks');
export const ListPlus = wrap(ListPlusIcon, 'ListPlus');
export const ListTodo = wrap(ListChecksIcon, 'ListTodo');
export const Loader2 = wrap(CircleNotchIcon, 'Loader2');
export const Lock = wrap(LockIcon, 'Lock');
export const LogOut = wrap(SignOutIcon, 'LogOut');
export const Maximize2 = wrap(ArrowsOutIcon, 'Maximize2');
export const MessageCircle = wrap(ChatCircleIcon, 'MessageCircle');
export const MessageSquare = wrap(ChatCircleIcon, 'MessageSquare');
export const Mic = wrap(MicrophoneIcon, 'Mic');
export const MicOff = wrap(MicrophoneSlashIcon, 'MicOff');
export const Minimize2 = wrap(ArrowsInIcon, 'Minimize2');
export const Monitor = wrap(MonitorIcon, 'Monitor');
export const MoreHorizontal = wrap(DotsThreeIcon, 'MoreHorizontal');
export const Navigation = wrap(NavigationArrowIcon, 'Navigation');
export const Network = wrap(GraphIcon, 'Network');
export const OctagonX = wrap(ProhibitIcon, 'OctagonX');
export const Package = wrap(PackageIcon, 'Package');
export const PanelLeft = wrap(SidebarSimpleIcon, 'PanelLeft');
export const Pause = wrap(PauseIcon, 'Pause');
export const Pencil = wrap(PencilSimpleIcon, 'Pencil');
export const Play = wrap(PlayIcon, 'Play');
export const PlayCircle = wrap(PlayCircleIcon, 'PlayCircle');
export const Plus = wrap(PlusIcon, 'Plus');
export const Power = wrap(PowerIcon, 'Power');
export const QrCode = wrap(QrCodeIcon, 'QrCode');
export const Quote = wrap(QuotesIcon, 'Quote');
export const Radio = wrap(BroadcastIcon, 'Radio');
export const RefreshCw = wrap(ArrowsClockwiseIcon, 'RefreshCw');
export const Repeat = wrap(RepeatIcon, 'Repeat');
export const Rocket = wrap(RocketLaunchIcon, 'Rocket');
export const RotateCcw = wrap(ArrowCounterClockwiseIcon, 'RotateCcw');
export const RotateCw = wrap(ArrowClockwiseIcon, 'RotateCw');
export const Save = wrap(FloppyDiskIcon, 'Save');
export const ScrollText = wrap(ScrollIcon, 'ScrollText');
export const Search = wrap(MagnifyingGlassIcon, 'Search');
export const Send = wrap(PaperPlaneRightIcon, 'Send');
export const Send2 = wrap(PaperPlaneTiltIcon, 'Send2');
export const Server = wrap(HardDrivesIcon, 'Server');
export const Settings = wrap(GearIcon, 'Settings');
export const Settings2 = wrap(GearSixIcon, 'Settings2');
export const ShareNetwork = wrap(ShareNetworkIcon, 'ShareNetwork');
export const Shield = wrap(ShieldIcon, 'Shield');
export const ShieldAlert = wrap(ShieldWarningIcon, 'ShieldAlert');
export const ShieldCheck = wrap(ShieldCheckIcon, 'ShieldCheck');
export const Shuffle = wrap(ShuffleIcon, 'Shuffle');
export const SkipForward = wrap(SkipForwardIcon, 'SkipForward');
export const Sliders = wrap(SlidersIcon, 'Sliders');
export const SlidersHorizontal = wrap(SlidersHorizontalIcon, 'SlidersHorizontal');
export const Smartphone = wrap(DeviceMobileIcon, 'Smartphone');
export const Sparkles = wrap(SparkleIcon, 'Sparkles');
export const Speech = wrap(SpeakerSimpleHighIcon, 'Speech');
export const Square = wrap(SquareIcon, 'Square');
export const Star = wrap(StarIcon, 'Star');
export const Tag = wrap(TagIcon, 'Tag');
export const Target = wrap(TargetIcon, 'Target');
export const Terminal = wrap(TerminalIcon, 'Terminal');
export const TerminalSquare = wrap(TerminalWindowIcon, 'TerminalSquare');
export const Trash2 = wrap(TrashIcon, 'Trash2');
export const TrendingUp = wrap(TrendUpIcon, 'TrendingUp');
export const TriangleAlert = wrap(WarningIcon, 'TriangleAlert');
export const Trophy = wrap(TrophyIcon, 'Trophy');
export const Unlink = wrap(LinkBreakIcon, 'Unlink');
export const Unlock = wrap(LockOpenIcon, 'Unlock');
export const Unplug = wrap(PlugsConnectedIcon, 'Unplug');
export const Upload = wrap(UploadSimpleIcon, 'Upload');
export const UploadCloud = wrap(CloudArrowUpIcon, 'UploadCloud');
export const User = wrap(UserIcon, 'User');
export const UserCheck = wrap(UserCheckIcon, 'UserCheck');
export const UserX = wrap(UserMinusIcon, 'UserX');
export const Users = wrap(UsersIcon, 'Users');
export const Volume2 = wrap(SpeakerHighIcon, 'Volume2');
export const VolumeX = wrap(SpeakerSlashIcon, 'VolumeX');
export const Wand2 = wrap(MagicWandIcon, 'Wand2');
export const Wifi = wrap(WifiHighIcon, 'Wifi');
export const WifiOff = wrap(WifiSlashIcon, 'WifiOff');
export const Workflow = wrap(FlowArrowIcon, 'Workflow');
export const Wrench = wrap(WrenchIcon, 'Wrench');
export const X = wrap(XIcon, 'X');
export const XCircle = wrap(XCircleIcon, 'XCircle');
export const Zap = wrap(LightningIcon, 'Zap');
export const ZoomIn = wrap(MagnifyingGlassPlusIcon, 'ZoomIn');
export const ZoomOut = wrap(MagnifyingGlassMinusIcon, 'ZoomOut');
