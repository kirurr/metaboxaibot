import { useState } from "react";
import { ChevronDown, Download, Trash2 } from "lucide-react";

export default function Profile() {
  const [name, setName] = useState("Alex Morgan");
  const [emailAddr, setEmailAddr] = useState("alex@northbound.co");
  const [sendOnEnter, setSendOnEnter] = useState(true);
  const [quiet, setQuiet] = useState(true);

  return (
    <div className="page">
      <div className="page-head rise">
        <div>
          <h1 className="h1">Profile</h1>
          <p className="sub">How you appear inside AI Box and how the product behaves for you.</p>
        </div>
      </div>

      <div className="two-col rise d1">
        <div className="card" style={{ padding: 26 }}>
          <h3 className="section-title">Account</h3>
          <div className="row" style={{ gap: 18, marginBottom: 12 }}>
            <div className="avatar lg">AM</div>
            <div>
              <div style={{ fontWeight: 600 }}>{name}</div>
              <div className="muted" style={{ fontSize: 13 }}>
                {emailAddr}
              </div>
              <div className="row" style={{ gap: 8, marginTop: 10 }}>
                <button className="btn btn-secondary btn-sm">Change photo</button>
                <button className="btn btn-ghost btn-sm">Remove</button>
              </div>
            </div>
          </div>
          <div className="divider" style={{ margin: "12px 0 4px" }} />
          <div className="field-row">
            <span className="lbl">Display name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn btn-ghost btn-sm">Save</button>
          </div>
          <div className="field-row">
            <span className="lbl">Email</span>
            <input
              className="input"
              value={emailAddr}
              onChange={(e) => setEmailAddr(e.target.value)}
            />
            <span className="chip success">Verified</span>
          </div>
          <div className="field-row">
            <span className="lbl">Password</span>
            <span className="val muted">Last changed 4 months ago</span>
            <button className="btn btn-secondary btn-sm">Change</button>
          </div>
          <div className="field-row">
            <span className="lbl">Two-factor auth</span>
            <span className="val">Authenticator app</span>
            <span className="chip success">Enabled</span>
          </div>
        </div>

        <div className="col" style={{ gap: 18 }}>
          <div className="card" style={{ padding: 22 }}>
            <h3 className="section-title">Preferences</h3>
            <div className="field-row" style={{ gridTemplateColumns: "1fr auto" }}>
              <div>
                <div style={{ fontSize: 14 }}>Default model</div>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  Used when starting a new chat
                </div>
              </div>
              <div className="model-picker">
                Sonnet 4.5 <ChevronDown size={14} />
              </div>
            </div>
            <div className="field-row" style={{ gridTemplateColumns: "1fr auto" }}>
              <div>
                <div style={{ fontSize: 14 }}>Response language</div>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  AI replies in this language by default
                </div>
              </div>
              <div className="model-picker">
                English <ChevronDown size={14} />
              </div>
            </div>
            <div className="field-row" style={{ gridTemplateColumns: "1fr auto" }}>
              <div>
                <div style={{ fontSize: 14 }}>Send on Enter</div>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  Shift+Enter for newline
                </div>
              </div>
              <button
                className={"toggle" + (sendOnEnter ? " on" : "")}
                onClick={() => setSendOnEnter(!sendOnEnter)}
              />
            </div>
            <div className="field-row" style={{ gridTemplateColumns: "1fr auto" }}>
              <div>
                <div style={{ fontSize: 14 }}>Quiet hours</div>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  Mute notifications 22:00 – 08:00
                </div>
              </div>
              <button
                className={"toggle" + (quiet ? " on" : "")}
                onClick={() => setQuiet(!quiet)}
              />
            </div>
          </div>

          <div className="card" style={{ padding: 22 }}>
            <h3 className="section-title">Data &amp; privacy</h3>
            <p className="muted" style={{ fontSize: 13.5, margin: "0 0 14px" }}>
              Your conversations are never used to train models. Export or delete everything any
              time.
            </p>
            <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
              <button className="btn btn-secondary btn-sm">
                <Download size={14} /> Export data
              </button>
              <button className="btn btn-ghost btn-sm" style={{ color: "var(--danger)" }}>
                <Trash2 size={14} /> Delete account
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
