import { ElMessage, ElMessageBox } from 'element-plus';
import { ApiError } from '../api/client';
import { t } from '../i18n';

export function showError(error: unknown, fallback = t('feedback.requestFailed')): void {
	ElMessage.error(error instanceof ApiError ? error.message : fallback);
}

export function showSuccess(message: string): void {
	ElMessage.success(message);
}

/** Reports a client-side validation problem that has no request behind it. */
export function showValidationError(message: string): void {
	ElMessage.error(message);
}

export async function confirmAction(message: string, title = t('feedback.confirmTitle')): Promise<boolean> {
	try {
		await ElMessageBox.confirm(message, title, {
			type: 'warning',
			confirmButtonText: t('common.confirm'),
			cancelButtonText: t('common.cancel'),
		});
		return true;
	} catch {
		return false;
	}
}
