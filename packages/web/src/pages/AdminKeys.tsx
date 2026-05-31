import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, Edit2, Loader2, ShieldOff, RotateCw } from "lucide-react";
import {
  adminApi,
  type ProviderKeyDto,
  type ProxyDto,
  type ProviderSummary,
  type KeyCreateBody,
} from "@/api/admin";
import { Button } from "@/components/common/Button";
import { Input } from "@/components/common/Input";
import { useUIStore } from "@/stores/uiStore";

const EMPTY: KeyCreateBody = {
  provider: "openai",
  label: "",
  keyValue: "",
  proxyId: null,
  priority: 0,
  isActive: true,
};

export default function AdminKeys() {
  const { t } = useTranslation();
  const pushToast = useUIStore((s) => s.pushToast);
  const [keys, setKeys] = useState<ProviderKeyDto[]>([]);
  const [proxies, setProxies] = useState<ProxyDto[]>([]);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterProvider, setFilterProvider] = useState<string>("");
  const [editing, setEditing] = useState<ProviderKeyDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<KeyCreateBody>(EMPTY);
  const [saving, setSaving] = useState(false);

  const reload = async () => {
    setLoading(true);
    try {
      const [k, p, pr] = await Promise.all([
        adminApi.listKeys(filterProvider || undefined),
        adminApi.listProxies(),
        adminApi.listProviders(),
      ]);
      setKeys(k.keys);
      setProxies(p.proxies);
      setProviders(pr.providers);
    } catch (err) {
      pushToast({ type: "error", message: (err as Error).message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, [filterProvider]);

  const startCreate = () => {
    setForm(EMPTY);
    setEditing(null);
    setCreating(true);
  };
  const startEdit = (k: ProviderKeyDto) => {
    setForm({
      provider: k.provider,
      label: k.label,
      keyValue: "",
      proxyId: k.proxyId,
      priority: k.priority,
      isActive: k.isActive,
      notes: k.notes ?? undefined,
    });
    setEditing(k);
    setCreating(false);
  };
  const cancel = () => {
    setEditing(null);
    setCreating(false);
    setForm(EMPTY);
  };

  const save = async () => {
    setSaving(true);
    try {
      if (editing) {
        const body: Partial<Omit<KeyCreateBody, "provider">> = {
          label: form.label,
          proxyId: form.proxyId,
          priority: form.priority,
          isActive: form.isActive,
          notes: form.notes,
        };
        if (form.keyValue) body.keyValue = form.keyValue;
        await adminApi.updateKey(editing.id, body);
      } else {
        if (!form.keyValue) {
          pushToast({ type: "error", message: t("admin.keyValueRequired") });
          setSaving(false);
          return;
        }
        await adminApi.createKey(form);
      }
      pushToast({ type: "success", message: t("common.saved") });
      cancel();
      await reload();
    } catch (err) {
      pushToast({ type: "error", message: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Удалить ключ?")) return;
    try {
      await adminApi.deleteKey(id);
      pushToast({ type: "success", message: t("common.deleted") });
      await reload();
    } catch (err) {
      pushToast({ type: "error", message: (err as Error).message });
    }
  };

  const clearThrottle = async (id: string) => {
    try {
      await adminApi.clearKeyThrottle(id);
      pushToast({ type: "success", message: "Throttle сброшен" });
      await reload();
    } catch (err) {
      pushToast({ type: "error", message: (err as Error).message });
    }
  };

  return (
    <div className="p-4 md:p-6 max-w-6xl">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">API-ключи провайдеров</h1>
        <div className="flex items-center gap-2">
          <select
            className="h-10 px-3"
            value={filterProvider}
            onChange={(e) => setFilterProvider(e.target.value)}
          >
            <option value="">Все провайдеры</option>
            {providers.map((p) => (
              <option key={p.provider} value={p.provider}>
                {p.provider} ({p.activeKeyCount})
              </option>
            ))}
          </select>
          <Button onClick={startCreate} leftIcon={<Plus size={16} />}>
            Добавить
          </Button>
        </div>
      </div>

      {(creating || editing) && (
        <div className="card p-4 mb-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Input
              label="Provider"
              value={form.provider}
              disabled={!!editing}
              onChange={(e) => setForm({ ...form, provider: e.target.value })}
              hint={editing ? "Изменить провайдера у существующего ключа нельзя" : undefined}
            />
            <Input
              label="Label"
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
            />
            <Input
              label={editing ? "Новое значение ключа (оставить пустым = не менять)" : "Key value"}
              type="password"
              value={form.keyValue}
              onChange={(e) => setForm({ ...form, keyValue: e.target.value })}
            />
            <div>
              <label className="text-xs font-medium text-text-secondary">Proxy</label>
              <select
                className="w-full h-12 px-3.5 mt-1.5"
                value={form.proxyId ?? ""}
                onChange={(e) => setForm({ ...form, proxyId: e.target.value || null })}
              >
                <option value="">— без прокси —</option>
                {proxies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} ({p.protocol}://{p.host}:{p.port})
                  </option>
                ))}
              </select>
            </div>
            <Input
              label="Priority (выше = используется первым)"
              type="number"
              value={form.priority ?? 0}
              onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
            />
            <div>
              <label className="text-xs font-medium text-text-secondary">Active</label>
              <div className="mt-3">
                <input
                  type="checkbox"
                  checked={form.isActive ?? true}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                />
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 mt-4">
            <Button onClick={save} loading={saving}>
              Сохранить
            </Button>
            <Button variant="ghost" onClick={cancel}>
              Отмена
            </Button>
          </div>
        </div>
      )}

      <div className="card overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-text-secondary">
            <Loader2 className="inline animate-spin" /> Загрузка
          </div>
        ) : keys.length === 0 ? (
          <div className="p-8 text-center text-text-secondary">Нет ключей</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-bg-elev-2 text-text-secondary">
              <tr>
                <th className="text-left px-3 py-2">Provider</th>
                <th className="text-left px-3 py-2">Label</th>
                <th className="text-left px-3 py-2">Key</th>
                <th className="text-left px-3 py-2">Proxy</th>
                <th className="text-right px-3 py-2">Priority</th>
                <th className="text-right px-3 py-2">Reqs</th>
                <th className="text-right px-3 py-2">Errors</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-right px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className="border-t border-border-default">
                  <td className="px-3 py-2">{k.provider}</td>
                  <td className="px-3 py-2 font-mono">{k.label}</td>
                  <td className="px-3 py-2 font-mono text-text-hint">{k.keyMask}</td>
                  <td className="px-3 py-2 text-text-hint">{k.proxy ? k.proxy.label : "—"}</td>
                  <td className="px-3 py-2 text-right">{k.priority}</td>
                  <td className="px-3 py-2 text-right text-text-hint">{k.requestCount}</td>
                  <td className="px-3 py-2 text-right text-text-hint">{k.errorCount}</td>
                  <td className="px-3 py-2">
                    <span className={k.isActive ? "text-success" : "text-text-hint"}>
                      {k.isActive ? "active" : "inactive"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => clearThrottle(k.id)}
                        title="Сбросить throttle"
                        className="p-1.5 hover:bg-bg-elev-2 rounded"
                      >
                        <ShieldOff size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => startEdit(k)}
                        title="Edit"
                        className="p-1.5 hover:bg-bg-elev-2 rounded"
                      >
                        <Edit2 size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(k.id)}
                        title="Delete"
                        className="p-1.5 hover:bg-bg-elev-2 rounded text-danger"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {providers.length > 0 && (
        <div className="mt-6">
          <div className="flex items-center gap-2 mb-2">
            <RotateCw size={14} className="text-text-secondary" />
            <h2 className="text-sm font-semibold text-text-secondary">Сводка по провайдерам</h2>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            {providers.map((p) => (
              <div key={p.provider} className="card p-3">
                <div className="font-mono">{p.provider}</div>
                <div className="text-text-hint text-xs">{p.activeKeyCount} active</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
