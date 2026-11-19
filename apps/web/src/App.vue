<script setup lang="ts">
import en from 'element-plus/es/locale/lang/en';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import { computed } from 'vue';
import AppLayout from './components/AppLayout.vue';
import { useI18n } from './i18n';

const { locale } = useI18n();
const elementLocale = computed(() => (locale.value === 'zh-CN' ? zhCn : en));
</script>

<template>
	<el-config-provider :locale="elementLocale">
		<AppLayout />
	</el-config-provider>
</template>
