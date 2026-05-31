import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, Edit2, PlugZap, Loader2 } from "lucide-react";
import { adminApi, type ProxyDto, type ProxyCreateBody } from "@/api/admin";
import { Button } from "@/components/common/Button";
import { Input } from "@/components/common/Input";
import { useUIStore } from "@/stores/uiStore";

const EMPTY: ProxyCreateBody = {
  label: "",
  protocol: "http",
  host: "",
  port: 8080,
  username: "",
  password: "",
  isActive: true,
};

export default function AdminProxies() {
  const { t } = useTranslation();
  const pushToast = useUIStore((s) => s.pushToast);
  const [proxies, setProxies] = useState<ProxyDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<ProxyDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<ProxyCreateBody>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    try {
      const { proxies } = await adminApi.listProxies();
      setProxies(proxies);
    } catch (err) {
      pushToast({ type: "error", message: (err as Error).message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, []);

  const startCreate = () => {
    setForm(EMPTY);
    setEditing(null);
    setCreating(true);
  };
  const startEdit = (p: ProxyDto) => {
    setForm({
      label: p.label,
      protocol: p.protocol,
      host: p.host,
      port: p.port,
      isActive: p.isActive,
      notes: p.notes ?? undefined,
    });
    setEditing(p);
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
        await adminApi.updateProxy(editing.id, form);
      } else {
        await adminApi.createProxy(form);
      }
      pushToast({ type: "success", message: t("admin.proxySaved") });
      cancel();
      await reload();
    } catch (err) {
      pushToast({ type: "error", message: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Удалить прокси?")) return;
    try {
      await adminApi.deleteProxy(id);
      pushToast({ type: "success", message: t("common.deleted") });
      await reload();
    } catch (err) {
      pushToast({ type: "error", message: (err as Error).message });
    }
  };

  const test = async (id: string) => {
    setTestingId(id);
    try {
      const r = await adminApi.testProxy(id);
      if (r.ok) pushToast({ type: "success", message: `IP: ${r.ip}` });
      else pushToast({ type: "error", message: r.error ?? "Не удалось" });
    } catch (err) {
      pushToast({ type: "error", message: (err as Error).message });
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div className="p-4 md:p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Прокси</h1>
        <Button onClick={startCreate} leftIcon={<Plus size={16} />}>
          Добавить
        </Button>
      </div>

      {(creating || editing) && (
        <div className="card p-4 mb-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Input
              label="Label"
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
            />
            <div>
              <label className="text-xs font-medium text-text-secondary">Protocol</label>
              <select
                className="w-full h-12 px-3.5 mt-1.5"
                value={form.protocol}
                onChange={(e) => setForm({ ...form, protocol: e.target.value })}
              >
                <option value="http">http</option>
                <option value="https">https</option>
                <option value="socks5">socks5</option>
              </select>
            </div>
            <Input
              label="Host"
              value={form.host}
              onChange={(e) => setForm({ ...form, host: e.target.value })}
            />
            <Input
              label="Port"
              type="number"
              value={form.port}
              onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
            />
            <Input
              label="Username (опционально)"
              value={form.username ?? ""}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
            <Input
              label="Password (оставить пустым = не менять)"
              type="password"
              value={form.password ?? ""}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
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
        ) : proxies.length === 0 ? (
          <div className="p-8 text-center text-text-secondary">Нет прокси</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-bg-elev-2 text-text-secondary">
              <tr>
                <th className="text-left px-3 py-2">Label</th>
                <th className="text-left px-3 py-2">Protocol</th>
                <th className="text-left px-3 py-2">Host:Port</th>
                <th className="text-left px-3 py-2">Auth</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-right px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {proxies.map((p) => (
                <tr key={p.id} className="border-t border-border-default">
                  <td className="px-3 py-2 font-mono">{p.label}</td>
                  <td className="px-3 py-2">{p.protocol}</td>
                  <td className="px-3 py-2 font-mono">
                    {p.host}:{p.port}
                  </td>
                  <td className="px-3 py-2 text-text-hint">{p.hasUsername ? "user/pass" : "—"}</td>
                  <td className="px-3 py-2">
                    <span className={p.isActive ? "text-success" : "text-text-hint"}>
                      {p.isActive ? "active" : "inactive"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => test(p.id)}
                        disabled={testingId === p.id}
                        title="Test"
                        className="p-1.5 hover:bg-bg-elev-2 rounded"
                      >
                        {testingId === p.id ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <PlugZap size={14} />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => startEdit(p)}
                        title="Edit"
                        className="p-1.5 hover:bg-bg-elev-2 rounded"
                      >
                        <Edit2 size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(p.id)}
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
    </div>
  );
}
