// Toasts for the shell (live events, copy confirmations). The <Toaster /> is mounted once in AppShell.
import { toast } from "sonner";

type Options = { description?: string; id?: string | number };

export const notify = {
  info: (message: string, options?: Options) => toast(message, options),
  success: (message: string, options?: Options) =>
    toast.success(message, options),
  error: (message: string, options?: Options) => toast.error(message, options),
  dismiss: (id?: string | number) => toast.dismiss(id),
};
