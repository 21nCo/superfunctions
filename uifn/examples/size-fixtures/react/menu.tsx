import { createRoot } from 'react-dom/client';
import { Menu } from '@uifn/react/menu';

const items = [{ id: 'rename' }, { id: 'duplicate' }, { id: 'delete' }];

function App() {
  return (
    <Menu.Root items={items}>
      <Menu.Trigger>Actions</Menu.Trigger>
      <Menu.Positioner>
        <Menu.Content>
          <Menu.Item value="rename">Rename</Menu.Item>
          <Menu.Item value="duplicate">Duplicate</Menu.Item>
          <Menu.Item value="delete">Delete</Menu.Item>
        </Menu.Content>
      </Menu.Positioner>
    </Menu.Root>
  );
}

createRoot(document.getElementById('app')!).render(<App />);
