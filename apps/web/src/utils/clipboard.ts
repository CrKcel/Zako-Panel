import { ElMessage } from 'element-plus';

export async function copyText(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		ElMessage.success('已复制');
	} catch {
		ElMessage.error('复制失败');
	}
}
