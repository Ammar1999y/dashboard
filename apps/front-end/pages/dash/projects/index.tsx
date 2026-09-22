import { ProjectsPage } from '@/components/projects/page';

export default function Projects() {
  return <ProjectsPage />;
}

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/projects',
      title: {
        template: 'المشاريع',
      },
    },
  };
}
