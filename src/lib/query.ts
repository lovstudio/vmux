import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

export const queryKeys = {
  commandSuggestions: (path: string) => ["command-suggestions", path] as const,
  serviceLogo: (path: string) => ["service-logo", path] as const,
  services: ["services"] as const,
};
