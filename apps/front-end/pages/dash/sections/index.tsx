import { SectionsPage } from '@/components/sections/page';

export default function Sections() {
  return <SectionsPage />;
}

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/sections',
      title: {
        template: 'الأقسام',
      },
    },
  };
}
