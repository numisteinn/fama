//! Tarjan strongly-connected-components over the file graph.

/// Returns every strongly connected component, in no particular order. Each
/// component is a list of node indices.
pub fn strongly_connected_components(out: &[Vec<usize>]) -> Vec<Vec<usize>> {
    let n = out.len();
    let mut state = State {
        out,
        index: vec![usize::MAX; n],
        low: vec![0; n],
        on_stack: vec![false; n],
        stack: Vec::new(),
        next_index: 0,
        components: Vec::new(),
    };
    for v in 0..n {
        if state.index[v] == usize::MAX {
            state.visit(v);
        }
    }
    state.components
}

struct State<'a> {
    out: &'a [Vec<usize>],
    index: Vec<usize>,
    low: Vec<usize>,
    on_stack: Vec<bool>,
    stack: Vec<usize>,
    next_index: usize,
    components: Vec<Vec<usize>>,
}

impl State<'_> {
    fn visit(&mut self, v: usize) {
        self.index[v] = self.next_index;
        self.low[v] = self.next_index;
        self.next_index += 1;
        self.stack.push(v);
        self.on_stack[v] = true;

        for &w in &self.out[v] {
            if self.index[w] == usize::MAX {
                self.visit(w);
                self.low[v] = self.low[v].min(self.low[w]);
            } else if self.on_stack[w] {
                self.low[v] = self.low[v].min(self.index[w]);
            }
        }

        if self.low[v] == self.index[v] {
            let mut component = Vec::new();
            loop {
                let w = self.stack.pop().unwrap();
                self.on_stack[w] = false;
                component.push(w);
                if w == v {
                    break;
                }
            }
            self.components.push(component);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_two_node_cycle() {
        // 0 -> 1 -> 0, plus 2 -> 0 (acyclic tail).
        let out = vec![vec![1], vec![0], vec![0]];
        let sccs = strongly_connected_components(&out);
        assert_eq!(sccs.len(), 2); // {0,1} and {2}
        let cycle = sccs.iter().find(|c| c.len() == 2).unwrap();
        assert!(cycle.contains(&0) && cycle.contains(&1));
    }

    #[test]
    fn acyclic_graph_has_singletons() {
        let out = vec![vec![1], vec![2], vec![]];
        let sccs = strongly_connected_components(&out);
        assert_eq!(sccs.len(), 3);
        assert!(sccs.iter().all(|c| c.len() == 1));
    }
}
