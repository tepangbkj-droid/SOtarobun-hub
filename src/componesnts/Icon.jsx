import * as LucideIcons from 'lucide-react';

/**
 * Kompatibilitas dengan kode lama yang memakai <i data-lucide="nama-ikon" className="...">
 * (Lucide versi UMD/CDN, nama kebab-case, di-render lewat lucide.createIcons()).
 *
 * Dengan lucide-react (npm), setiap ikon adalah komponen React PascalCase (mis. "log-out"
 * menjadi <LogOut />). Komponen <Icon name="log-out" className="..." /> ini menerjemahkan
 * nama kebab-case -> PascalCase secara otomatis, supaya SEMUA 146 pemakaian ikon di App.jsx
 * (termasuk yang namanya dinamis, mis. name={isSaving ? 'loader' : 'save'}) tetap berfungsi
 * tanpa perlu diubah satu per satu.
 */
function kebabToPascal(name) {
  return String(name)
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

// Cache hasil lookup supaya tidak menghitung ulang di setiap render.
const iconCache = new Map();

function resolveIcon(name) {
  if (!name) return null;
  if (iconCache.has(name)) return iconCache.get(name);

  const pascal = kebabToPascal(name);
  // lucide-react mengekspor beberapa ikon dengan alias berbeda dari nama file lucide
  // klasik (mis. "edit" -> Edit, "edit-2" -> Edit2, "edit-3" -> Edit3). Pencarian
  // langsung di atas sudah menutupi hampir semua kasus karena penamaan lucide-react
  // memang PascalCase dari kebab-case aslinya.
  const Component = LucideIcons[pascal] || null;
  iconCache.set(name, Component);
  return Component;
}

export default function Icon({ name, className, ...rest }) {
  const LucideIcon = resolveIcon(name);

  if (!LucideIcon) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn(`[Icon] Ikon lucide-react tidak ditemukan untuk nama: "${name}"`);
    }
    return null;
  }

  return <LucideIcon className={className} {...rest} />;
}
