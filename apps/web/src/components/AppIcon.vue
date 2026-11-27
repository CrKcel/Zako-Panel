<script setup lang="ts">
import {
	Activity,
	AlertTriangle,
	ArrowDown,
	ArrowLeft,
	ArrowUp,
	Ban,
	Check,
	ChevronLeft,
	ChevronRight,
	Clock,
	Command,
	Copy,
	Cpu,
	Download,
	Eye,
	FileCode2,
	Globe,
	HardDrive,
	Info,
	KeyRound,
	LayoutDashboard,
	LayoutGrid,
	Link2,
	List,
	Menu,
	Monitor,
	Moon,
	PanelLeftClose,
	PanelLeftOpen,
	Pause,
	Pencil,
	Play,
	Plus,
	RefreshCw,
	RotateCcw,
	Search,
	Server,
	Shield,
	SlidersHorizontal,
	Sun,
	Terminal,
	Trash2,
	Users,
	X,
} from '@lucide/vue';
import { computed, type Component } from 'vue';

export type IconName =
	| 'overview'
	| 'nodes'
	| 'subscribers'
	| 'profiles'
	| 'subscriptions'
	| 'traffic'
	| 'menu'
	| 'refresh'
	| 'plus'
	| 'back'
	| 'copy'
	| 'check'
	| 'arrow-up'
	| 'arrow-down'
	| 'activity'
	| 'globe'
	| 'sun'
	| 'moon'
	| 'monitor'
	| 'search'
	| 'sliders'
	| 'terminal'
	| 'shield'
	| 'key'
	| 'chevron-right'
	| 'chevron-left'
	| 'panel-collapse'
	| 'panel-expand'
	| 'pause'
	| 'play'
	| 'download'
	| 'grid'
	| 'list'
	| 'alert'
	| 'close'
	| 'command'
	| 'cpu'
	| 'hard-drive'
	| 'clock'
	| 'eye'
	| 'edit'
	| 'trash'
	| 'rotate'
	| 'ban'
	| 'info';

const ICONS: Record<IconName, Component> = {
	overview: LayoutDashboard,
	nodes: Server,
	subscribers: Users,
	profiles: FileCode2,
	subscriptions: Link2,
	traffic: Activity,
	menu: Menu,
	refresh: RefreshCw,
	plus: Plus,
	back: ArrowLeft,
	copy: Copy,
	check: Check,
	'arrow-up': ArrowUp,
	'arrow-down': ArrowDown,
	activity: Activity,
	globe: Globe,
	sun: Sun,
	moon: Moon,
	monitor: Monitor,
	search: Search,
	sliders: SlidersHorizontal,
	terminal: Terminal,
	shield: Shield,
	key: KeyRound,
	'chevron-right': ChevronRight,
	'chevron-left': ChevronLeft,
	'panel-collapse': PanelLeftClose,
	'panel-expand': PanelLeftOpen,
	pause: Pause,
	play: Play,
	download: Download,
	grid: LayoutGrid,
	list: List,
	alert: AlertTriangle,
	close: X,
	command: Command,
	cpu: Cpu,
	'hard-drive': HardDrive,
	clock: Clock,
	eye: Eye,
	edit: Pencil,
	trash: Trash2,
	rotate: RotateCcw,
	ban: Ban,
	info: Info,
};

const props = withDefaults(
	defineProps<{
		name: IconName;
		size?: number;
		strokeWidth?: number;
	}>(),
	{
		size: 16,
		strokeWidth: 1.75,
	},
);

const iconComponent = computed(() => ICONS[props.name]);
</script>

<template>
	<component :is="iconComponent" :size="size" :stroke-width="strokeWidth" aria-hidden="true" class="app-icon" />
</template>

<style scoped>
.app-icon {
	flex: none;
	display: inline-block;
	vertical-align: middle;
}
</style>
