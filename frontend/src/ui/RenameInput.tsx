// The inline rename field shared by every renamable row (class names, node names, function
// names). Mounts focused with its text selected; Enter commits, Escape cancels, blur commits.
// Cancelling is fiddly: Escape clears the parent's editing flag, which unmounts this input and
// fires blur, so the guard below tells that blur not to also commit the value being discarded.
// The click is stopped so editing a row's name never doubles as selecting the row.

export interface RenameInputProps {
    value: string;
    onCommit: (value: string) => void;
    onCancel: () => void;
    class?: string;
    placeholder?: string;
}

export function RenameInput(props: RenameInputProps) {
    let cancelling = false;
    return (
        <input
            class={props.class}
            value={props.value}
            placeholder={props.placeholder}
            ref={(el) => {
                el.focus();
                el.select();
            }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
                if (e.key === "Enter") props.onCommit(e.currentTarget.value);
                else if (e.key === "Escape") {
                    cancelling = true;
                    props.onCancel();
                }
            }}
            onBlur={(e) => {
                if (cancelling) {
                    cancelling = false;
                    return;
                }
                props.onCommit(e.currentTarget.value);
            }}
        />
    );
}
