import { useState } from 'react'
import { ActionsBackfill } from '@/components/ActionsBackfill'
import { BackstopBackfill } from '@/components/BackstopBackfill'
import { SyncPoolsTokens } from '@/components/SyncPoolsTokens'
import { LpPriceBackfill } from '@/components/LpPriceBackfill'
import { PoolSnapshotsBackfill } from '@/components/PoolSnapshotsBackfill'
import { TokensList } from '@/components/TokensList'
import { ExploreModule } from '@/components/ExploreModule'
import { AppSidebar, type ModuleKey } from '@/components/AppSidebar'
import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
} from '@/components/ui/sidebar'

function App() {
  const [activeModule, setActiveModule] = useState<ModuleKey>('tokens')

  const renderModule = () => {
    switch (activeModule) {
      case 'tokens':
        return <TokensList />
      case 'actions':
        return <ActionsBackfill />
      case 'backstop':
        return <BackstopBackfill />
      case 'lp-price':
        return <LpPriceBackfill />
      case 'pool-snapshots':
        return <PoolSnapshotsBackfill />
      case 'sync':
        return <SyncPoolsTokens />
      case 'explore':
        return <ExploreModule />
      default:
        return <TokensList />
    }
  }

  return (
    <SidebarProvider>
      <AppSidebar activeModule={activeModule} onModuleChange={setActiveModule} />
      <SidebarInset>
        <header className="flex h-12 items-center border-b px-4">
          <SidebarTrigger />
        </header>
        <main className="flex-1 overflow-auto p-6">
          {renderModule()}
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}

export default App
