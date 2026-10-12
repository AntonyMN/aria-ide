import Swal from 'sweetalert2';
import 'sweetalert2/dist/sweetalert2.min.css';

// Base dark theme configuration for SweetAlert2 matching Antigravity IDE
const darkSwal = Swal.mixin({
  background: '#0c101a',
  color: '#e2e8f0',
  backdrop: 'rgba(5, 7, 10, 0.75)',
  customClass: {
    popup: 'swal-ide-popup',
    title: 'swal-ide-title',
    htmlContainer: 'swal-ide-html',
    confirmButton: 'swal-ide-confirm',
    cancelButton: 'swal-ide-cancel',
    input: 'swal-ide-input',
  },
  buttonsStyling: false,
});

/**
 * Ask confirmation before stopping AI generation
 */
export async function confirmStopGeneration(): Promise<boolean> {
  const result = await darkSwal.fire({
    title: 'Stop AI Generation?',
    text: 'Are you sure you want to stop the AI agent response and reasoning loop?',
    icon: 'warning',
    iconColor: '#f59e0b',
    showCancelButton: true,
    confirmButtonText: 'Yes, Stop Generation',
    cancelButtonText: 'Keep Generating',
    reverseButtons: true,
    customClass: {
      popup: 'swal-ide-popup',
      title: 'swal-ide-title',
      htmlContainer: 'swal-ide-html',
      confirmButton: 'swal-ide-confirm-danger',
      cancelButton: 'swal-ide-cancel',
    },
  });
  return result.isConfirmed;
}

/**
 * Custom styled prompt replacing window.prompt
 */
export async function promptText(options: {
  title: string;
  text?: string;
  placeholder?: string;
  inputValue?: string;
  confirmButtonText?: string;
}): Promise<string | null> {
  const result = await darkSwal.fire({
    title: options.title,
    text: options.text,
    input: 'text',
    inputValue: options.inputValue || '',
    inputPlaceholder: options.placeholder || '',
    showCancelButton: true,
    confirmButtonText: options.confirmButtonText || 'Confirm',
    cancelButtonText: 'Cancel',
    reverseButtons: true,
    inputValidator: (value) => {
      if (!value || !value.trim()) {
        return 'This field cannot be empty';
      }
      return null;
    },
  });

  if (result.isConfirmed && result.value) {
    return result.value.trim();
  }
  return null;
}

/**
 * Custom confirmation dialog replacing window.confirm
 */
export async function confirmAction(options: {
  title: string;
  text: string;
  confirmButtonText?: string;
  isDanger?: boolean;
}): Promise<boolean> {
  const result = await darkSwal.fire({
    title: options.title,
    text: options.text,
    icon: options.isDanger ? 'warning' : 'question',
    iconColor: options.isDanger ? '#ef4444' : '#00f0ff',
    showCancelButton: true,
    confirmButtonText: options.confirmButtonText || 'Confirm',
    cancelButtonText: 'Cancel',
    reverseButtons: true,
    customClass: {
      popup: 'swal-ide-popup',
      title: 'swal-ide-title',
      htmlContainer: 'swal-ide-html',
      confirmButton: options.isDanger ? 'swal-ide-confirm-danger' : 'swal-ide-confirm',
      cancelButton: 'swal-ide-cancel',
    },
  });
  return result.isConfirmed;
}

/**
 * Error alert popup replacing alert(...)
 */
export async function showErrorAlert(title: string, message: string): Promise<void> {
  await darkSwal.fire({
    title,
    text: message,
    icon: 'error',
    iconColor: '#ef4444',
    confirmButtonText: 'Dismiss',
  });
}

/**
 * Warning alert popup replacing alert(...)
 */
export async function showWarningAlert(title: string, message: string): Promise<void> {
  await darkSwal.fire({
    title,
    text: message,
    icon: 'warning',
    iconColor: '#f59e0b',
    confirmButtonText: 'Understood',
  });
}

/**
 * Quick non-blocking toast notification
 */
export function showSuccessToast(message: string): void {
  darkSwal.fire({
    toast: true,
    position: 'top-end',
    icon: 'success',
    iconColor: '#10b981',
    title: message,
    showConfirmButton: false,
    timer: 2500,
    timerProgressBar: true,
  });
}
