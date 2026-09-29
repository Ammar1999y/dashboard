'use client';

import type { TCodeBlockElement, TCodeSyntaxLeaf } from 'platejs';
import type { PlateElementProps, PlateLeafProps } from 'platejs/react';

import * as React from 'react';

import { formatCodeBlock, isLangSupported } from '@platejs/code-block';
import { NodeApi } from 'platejs';
import {
  PlateElement,
  PlateLeaf,
  useEditorRef,
  useElement,
  useReadOnly,
} from 'platejs/react';
import { cn } from '@/lib/utils';

import { NO_RESULTS_MESSAGE } from '@/utils/ui-messages';

import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Icon } from '@/components/ui/icon';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  CODE_BLOCK_CLASS,
  CODE_BLOCK_PRE_CLASS,
  CODE_BLOCK_SURFACE_CLASS,
} from '@/components/editor/styles';

const PLAIN_TEXT = 'plaintext';
const COPIED_MS = 2000;

export function CodeBlockElement(props: PlateElementProps<TCodeBlockElement>) {
  const { editor, element } = props;

  return (
    <PlateElement className={CODE_BLOCK_CLASS} {...props}>
      <div className={CODE_BLOCK_SURFACE_CLASS}>
        <pre className={CODE_BLOCK_PRE_CLASS}>
          <code>{props.children}</code>
        </pre>

        <div
          className='absolute top-1 z-10 flex select-none gap-0.5 ltr:left-1 rtl:right-1'
          contentEditable={false}
        >
          {isLangSupported(element.lang) && (
            <Button
              aria-label='تنسيق الكود'
              className='size-6 text-xs'
              onClick={() => formatCodeBlock(editor, { element })}
              size='icon'
              title='تنسيق الكود'
              variant='ghost'
            >
              <Icon
                icon='solar:braces-linear'
                className='!size-3.5 text-muted-foreground'
              />
            </Button>
          )}

          <CodeBlockCombobox />

          <CopyButton
            className='size-6 gap-1 text-xs text-muted-foreground'
            getValue={() => NodeApi.string(element)}
          />
        </div>
      </div>
    </PlateElement>
  );
}

function CodeBlockCombobox() {
  const [open, setOpen] = React.useState(false);
  const readOnly = useReadOnly();
  const editor = useEditorRef();
  const element = useElement<TCodeBlockElement>();
  const value = element.lang || PLAIN_TEXT;
  const [search, setSearch] = React.useState('');

  const items = React.useMemo(() => {
    const query = search.toLowerCase();
    return query
      ? LANGUAGES.filter((language) =>
          language.label.toLowerCase().includes(query)
        )
      : LANGUAGES;
  }, [search]);

  if (readOnly) return null;

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          className='h-6 select-none justify-between gap-1 px-2 text-xs text-muted-foreground'
          role='combobox'
          size='sm'
          variant='ghost'
        >
          {LANGUAGES.find((language) => language.value === value)?.label ??
            value}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className='w-48 p-0'
        onCloseAutoFocus={() => setSearch('')}
      >
        <Command shouldFilter={false}>
          <CommandInput
            className='h-9'
            onValueChange={setSearch}
            placeholder='البحث عن اللغات'
            value={search}
          />
          <CommandEmpty>{NO_RESULTS_MESSAGE}</CommandEmpty>

          <CommandList className='h-80 overflow-y-auto'>
            <CommandGroup>
              {items.map((language) => (
                <CommandItem
                  className='cursor-pointer'
                  key={language.value}
                  onSelect={(lang) => {
                    editor.tf.setNodes<TCodeBlockElement>(
                      { lang },
                      { at: element }
                    );
                    setOpen(false);
                  }}
                  value={language.value}
                >
                  <Icon
                    icon='solar:check-read-linear'
                    className={cn(
                      value === language.value ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  {language.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function CopyButton({
  className,
  getValue,
}: {
  className?: string;
  getValue: () => string;
}) {
  const [hasCopied, setHasCopied] = React.useState(false);

  React.useEffect(() => {
    if (!hasCopied) return;
    const timer = setTimeout(() => setHasCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [hasCopied]);

  return (
    <Button
      aria-label='نسخ'
      className={className}
      onClick={() => {
        navigator.clipboard
          .writeText(getValue())
          .then(() => setHasCopied(true))
          .catch(() => setHasCopied(false));
      }}
      size='icon'
      variant='ghost'
    >
      <Icon
        icon={hasCopied ? 'solar:check-read-linear' : 'solar:copy-linear'}
        className='!size-3'
      />
    </Button>
  );
}

export function CodeLineElement(props: PlateElementProps) {
  return <PlateElement {...props} />;
}

export function CodeSyntaxLeaf(props: PlateLeafProps<TCodeSyntaxLeaf>) {
  return <PlateLeaf className={props.leaf.className} {...props} />;
}

const LANGUAGES: { label: string; value: string }[] = [
  { label: 'Auto', value: 'auto' },
  { label: 'Plain Text', value: 'plaintext' },
  { label: 'ABAP', value: 'abap' },
  { label: 'Agda', value: 'agda' },
  { label: 'Arduino', value: 'arduino' },
  { label: 'ASCII Art', value: 'ascii' },
  { label: 'Assembly', value: 'x86asm' },
  { label: 'Bash', value: 'bash' },
  { label: 'BASIC', value: 'basic' },
  { label: 'BNF', value: 'bnf' },
  { label: 'C', value: 'c' },
  { label: 'C#', value: 'csharp' },
  { label: 'C++', value: 'cpp' },
  { label: 'Clojure', value: 'clojure' },
  { label: 'CoffeeScript', value: 'coffeescript' },
  { label: 'Coq', value: 'coq' },
  { label: 'CSS', value: 'css' },
  { label: 'Dart', value: 'dart' },
  { label: 'Dhall', value: 'dhall' },
  { label: 'Diff', value: 'diff' },
  { label: 'Docker', value: 'dockerfile' },
  { label: 'EBNF', value: 'ebnf' },
  { label: 'Elixir', value: 'elixir' },
  { label: 'Elm', value: 'elm' },
  { label: 'Erlang', value: 'erlang' },
  { label: 'F#', value: 'fsharp' },
  { label: 'Flow', value: 'flow' },
  { label: 'Fortran', value: 'fortran' },
  { label: 'Gherkin', value: 'gherkin' },
  { label: 'GLSL', value: 'glsl' },
  { label: 'Go', value: 'go' },
  { label: 'GraphQL', value: 'graphql' },
  { label: 'Groovy', value: 'groovy' },
  { label: 'Haskell', value: 'haskell' },
  { label: 'HCL', value: 'hcl' },
  { label: 'HTML', value: 'html' },
  { label: 'Idris', value: 'idris' },
  { label: 'Java', value: 'java' },
  { label: 'JavaScript', value: 'javascript' },
  { label: 'JSON', value: 'json' },
  { label: 'Julia', value: 'julia' },
  { label: 'Kotlin', value: 'kotlin' },
  { label: 'LaTeX', value: 'latex' },
  { label: 'Less', value: 'less' },
  { label: 'Lisp', value: 'lisp' },
  { label: 'LiveScript', value: 'livescript' },
  { label: 'LLVM IR', value: 'llvm' },
  { label: 'Lua', value: 'lua' },
  { label: 'Makefile', value: 'makefile' },
  { label: 'Markdown', value: 'markdown' },
  { label: 'Markup', value: 'markup' },
  { label: 'MATLAB', value: 'matlab' },
  { label: 'Mathematica', value: 'mathematica' },
  { label: 'Mermaid', value: 'mermaid' },
  { label: 'Nix', value: 'nix' },
  { label: 'Notion Formula', value: 'notion' },
  { label: 'Objective-C', value: 'objectivec' },
  { label: 'OCaml', value: 'ocaml' },
  { label: 'Pascal', value: 'pascal' },
  { label: 'Perl', value: 'perl' },
  { label: 'PHP', value: 'php' },
  { label: 'PowerShell', value: 'powershell' },
  { label: 'Prolog', value: 'prolog' },
  { label: 'Protocol Buffers', value: 'protobuf' },
  { label: 'PureScript', value: 'purescript' },
  { label: 'Python', value: 'python' },
  { label: 'R', value: 'r' },
  { label: 'Racket', value: 'racket' },
  { label: 'Reason', value: 'reasonml' },
  { label: 'Ruby', value: 'ruby' },
  { label: 'Rust', value: 'rust' },
  { label: 'Scala', value: 'scala' },
  { label: 'Scheme', value: 'scheme' },
  { label: 'SCSS', value: 'scss' },
  { label: 'Shell', value: 'shell' },
  { label: 'Smalltalk', value: 'smalltalk' },
  { label: 'Solidity', value: 'solidity' },
  { label: 'SQL', value: 'sql' },
  { label: 'Swift', value: 'swift' },
  { label: 'TOML', value: 'toml' },
  { label: 'TypeScript', value: 'typescript' },
  { label: 'VB.Net', value: 'vbnet' },
  { label: 'Verilog', value: 'verilog' },
  { label: 'VHDL', value: 'vhdl' },
  { label: 'WebAssembly', value: 'wasm' },
  { label: 'XML', value: 'xml' },
  { label: 'YAML', value: 'yaml' },
];
