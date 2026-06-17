import { useEffect, useState } from 'react';
import { getBackendUrl } from '../../../utils/apiConfig';
import type { AgentRoleTag } from './useMobileAgentAssistant';

export type MobileRoleTagMap = Record<string, AgentRoleTag>;

export function useMobileRoleTags() {
  const [roleTagMap, setRoleTagMap] = useState<MobileRoleTagMap>({});

  useEffect(() => {
    let cancelled = false;

    const loadRoleTags = async () => {
      try {
        const backendUrl = getBackendUrl();
        const response = await fetch(`${backendUrl}/api/data/role_tag_mapping.json`);
        if (response.ok && !cancelled) {
          const data = await response.json();
          setRoleTagMap(data);
        }
      } catch (error) {
        console.error('加载角色Tag映射失败:', error);
      }
    };

    void loadRoleTags();

    return () => {
      cancelled = true;
    };
  }, []);

  return roleTagMap;
}
