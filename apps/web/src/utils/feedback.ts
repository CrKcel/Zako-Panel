import { ElMessage, ElMessageBox } from 'element-plus';
import { ApiError } from '../api/client';

export function showError(error: unknown, fallback = '请求失败'): void {
	ElMessage.error(error instanceof ApiError ? error.message : fallback);
}

export function showSuccess(message: string): void {
	ElMessage.success(message);
}

export async function confirmAction(message: string, title = '确认操作'): Promise<boolean> {
	try {
		await ElMessageBox.confirm(message, title, {
			type: 'warning',
			confirmButtonText: '确定',
			cancelButtonText: '取消',
		});
		return true;
	} catch {
		return false;
	}
}
