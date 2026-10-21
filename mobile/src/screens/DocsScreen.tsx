import { BookOpenTextIcon } from '@phosphor-icons/react';
import { EmptyState } from '../components/ui';

/** Документация проекта (TASK-140.17). Заготовка: экран пишется в этой задаче. */
export function DocsScreen() {
  return <EmptyState icon={<BookOpenTextIcon size={40} />} title="Docs" />;
}
