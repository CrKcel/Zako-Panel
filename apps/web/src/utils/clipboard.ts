import { ElMessage } from 'element-plus';
import { t } from '../i18n';

export async function copyText(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		ElMessage.success(t('common.copied'));
	} catch {
		ElMessage.error(t('common.copyFailed'));
	}
}
