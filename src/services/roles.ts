export const normalizeRole = (role: unknown): string => {
  const key = String(role ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['super_admin', 'superadmin'].includes(key)) return 'SUPER_ADMIN';
  if (['lgu_admin', 'lguadmin'].includes(key)) return 'LGU_ADMIN';
  if (['barangay_official', 'barangayofficial'].includes(key)) return 'BARANGAY_OFFICIAL';
  if (key === 'resident') return 'RESIDENT';
  return 'RESIDENT';
};

export const SUPER_ADMIN_ROLE_VALUES = ['SUPER_ADMIN', 'superadmin', 'super_admin', 'Super Admin'];
export const LGU_ADMIN_ROLE_VALUES = ['LGU_ADMIN', 'lgu_admin', 'LGU Admin', 'lguadmin'];
export const MUNICIPAL_ADMIN_ROLE_VALUES = [...SUPER_ADMIN_ROLE_VALUES, ...LGU_ADMIN_ROLE_VALUES];

export const isMunicipalityAdmin = (role: string | undefined) => {
  const canonical = normalizeRole(role);
  return canonical === 'LGU_ADMIN' || canonical === 'SUPER_ADMIN';
};
