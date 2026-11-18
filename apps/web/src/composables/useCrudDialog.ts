import { ref, type Ref } from 'vue';

export interface CrudDialogOptions {
	/** Restores the form to its create defaults before `openCreate`. */
	reset?: () => void;
	/** Loads the record into the form before the dialog opens; a rejection keeps it closed. */
	load?: (id: string) => void | Promise<void>;
	/** Reports a failure of `load`. */
	onError?: (error: unknown) => void;
}

export interface CrudDialog {
	visible: Ref<boolean>;
	/** Id of the record being edited; null while creating. */
	editingId: Ref<string | null>;
	submitting: Ref<boolean>;
	openCreate: () => void;
	openEdit: (id: string) => Promise<void>;
	close: () => void;
	/** Runs a submit with `submitting` held; resolves to false when it threw. */
	submit: (task: () => Promise<void>, onError?: (error: unknown) => void) => Promise<boolean>;
}

export function useCrudDialog(options: CrudDialogOptions = {}): CrudDialog {
	const visible = ref(false);
	const editingId = ref<string | null>(null);
	const submitting = ref(false);

	function close(): void {
		visible.value = false;
	}

	function openCreate(): void {
		editingId.value = null;
		options.reset?.();
		visible.value = true;
	}

	async function openEdit(id: string): Promise<void> {
		editingId.value = id;
		if (options.load !== undefined) {
			try {
				await options.load(id);
			} catch (caught) {
				editingId.value = null;
				options.onError?.(caught);
				return;
			}
		}
		visible.value = true;
	}

	async function submit(task: () => Promise<void>, onError?: (error: unknown) => void): Promise<boolean> {
		submitting.value = true;
		try {
			await task();
			return true;
		} catch (caught) {
			onError?.(caught);
			return false;
		} finally {
			submitting.value = false;
		}
	}

	return { visible, editingId, submitting, openCreate, openEdit, close, submit };
}
