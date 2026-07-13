import { useEffect, useState } from 'react';
import { appBackendApi } from '../../../api/appBackendApi';
import type { AgentRoleTag } from './useMobileAgentAssistant';

export type MobileRoleTagMap = Record<string, AgentRoleTag>;

export function useMobileRoleTags() {
  const [roleTagMap, setRoleTagMap] = useState<MobileRoleTagMap>({});

  useEffect(() => {
    let cancelled = false;

    const loadRoleTags = async () => {
      try {
        const response = await appBackendApi.request('/api/data/role_tag_mapping.json');
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
