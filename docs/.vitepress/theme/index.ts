import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import Layout from './Layout.vue'
import EnvTable from './components/EnvTable.vue'
import Figure from './components/Figure.vue'
import LaunchChecklist from './components/LaunchChecklist.vue'
import RecordUri from './components/RecordUri.vue'
import StateDiagram from './components/StateDiagram.vue'
import Term from './components/Term.vue'
import { findRedirect } from './redirects'
import './custom.css'

export const theme: Theme = {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app, router }) {
    app.component('EnvTable', EnvTable)
    app.component('Figure', Figure)
    app.component('LaunchChecklist', LaunchChecklist)
    app.component('RecordUri', RecordUri)
    app.component('StateDiagram', StateDiagram)
    app.component('Term', Term)

    if (typeof window === 'undefined') return
    router.onBeforeRouteChange = async (href) => {
      const target = findRedirect(href)
      if (target === undefined) return true
      // Replace, not push, so Back does not land on the old URL again.
      window.history.replaceState(null, '', target)
      await router.go(target)
      return false
    }
  },
}

export default theme
