import { useState, type ReactElement } from 'react';
import * as skill from '../skills';
import type { ConversationChatModel } from '../skills';
import { errorText } from '../lib/http';
import { formatModelLabel } from '../lib/live-model';
import { set, useEntity } from '../store/cache';
import { K } from '../store/keys';
import { ModelPickerField } from './ModelPickerField';

/** One line for the header: what runs, and whether a pin is why. */
export function describeChatModel(state: ConversationChatModel): {
  label: string;
  note: string;
} {
  const label = formatModelLabel(state.provider, state.model);
  if (state.override === null) return { label, note: 'default' };
  if (state.provider !== state.conversationProvider) {
    // Your own default provider outranks this chat's, so the pin is stored
    // but is not what runs. Say so rather than show a pin that does nothing.
    return {
      label,
      note: `pin ${state.override} not in effect — it applies to ${state.conversationProvider}`,
    };
  }
  return { label, note: 'pinned for this chat' };
}

const BUTTON_CLASS =
  'rounded-[8px] border border-border px-2.5 py-1 text-[11.5px] font-semibold text-text-primary transition-colors hover:bg-surface-elevated disabled:opacity-40';

/**
 * Which model this chat runs on, and a way to pin another for it alone.
 *
 * The value shown comes from the server's resolution of the next turn — the
 * same function the turn itself calls — never from a copy of the precedence
 * rules here. Choices are scoped to the chat's own provider, the only one a
 * pin can apply to; the server validates the pick and its refusal is shown
 * as is.
 */
export function ConversationModelPicker({
  conversationId,
}: {
  conversationId: string;
}): ReactElement | null {
  const key = K.conversationModel(conversationId);
  const { data, error } = useEntity<ConversationChatModel>(key, () =>
    skill.getConversationModel(conversationId)
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  if (data === undefined) {
    return error !== undefined ? (
      <span className="font-mono text-[11px] text-error">
        {errorText(error, 'Could not load the chat model.')}
      </span>
    ) : null;
  }

  const save = async (model: string | null): Promise<void> => {
    setSaving(true);
    setSaveError(null);
    try {
      set(key, await skill.setConversationModel(conversationId, model));
      setEditing(false);
    } catch (e: unknown) {
      setSaveError(errorText(e, 'Could not change the model.'));
    } finally {
      setSaving(false);
    }
  };

  const { label, note } = describeChatModel(data);
  const trimmed = draft.trim();

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-[11px] text-text-secondary" title="Provider · model">
        {label}
      </span>
      <span className="text-[11px] text-text-tertiary">({note})</span>
      {!editing ? (
        <button
          type="button"
          onClick={() => {
            setDraft(data.override ?? '');
            setSaveError(null);
            setEditing(true);
          }}
          className={BUTTON_CLASS}
        >
          Change model
        </button>
      ) : (
        <>
          <ModelPickerField
            agentId={data.conversationProvider}
            value={draft}
            onChange={setDraft}
            disabled={saving}
            placeholder={`${data.conversationProvider} model id`}
            ariaLabel="Model for this chat"
            className="min-w-[200px]"
          />
          <button
            type="button"
            onClick={() => void save(trimmed)}
            disabled={saving || trimmed === '' || trimmed === data.override}
            className={BUTTON_CLASS}
          >
            {saving ? 'Saving…' : 'Pin'}
          </button>
          {data.override !== null ? (
            <button
              type="button"
              onClick={() => void save(null)}
              disabled={saving}
              className={BUTTON_CLASS}
            >
              Reset to default
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setSaveError(null);
            }}
            disabled={saving}
            className="text-[11.5px] text-text-tertiary hover:text-text-primary"
          >
            Cancel
          </button>
        </>
      )}
      {saveError !== null ? (
        <span className="font-mono text-[11px] text-error">{saveError}</span>
      ) : null}
    </div>
  );
}
