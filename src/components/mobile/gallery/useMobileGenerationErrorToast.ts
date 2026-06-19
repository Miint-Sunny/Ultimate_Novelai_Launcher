import { useEffect, useState } from 'react';

interface GenerationLikeResult {
  success: boolean;
}

export function useMobileGenerationErrorToast(result: GenerationLikeResult | null) {
  const [showError, setShowError] = useState(true);

  useEffect(() => {
    if (result && !result.success) {
      setShowError(true);
    }
  }, [result]);

  return {
    showError,
    setShowError,
  };
}
